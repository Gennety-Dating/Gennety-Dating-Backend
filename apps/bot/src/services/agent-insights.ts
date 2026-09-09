import { prisma } from "@gennety/db";
import {
  CADENCE,
  FACE_SIMILARITY_THRESHOLD,
  MAX_PHOTOS,
  MIN_PHOTOS,
  PHOTO_BONUS_TICKET_THRESHOLD,
} from "@gennety/shared";

/**
 * Read-only matchmaking insight for the menu agent.
 *
 * The agent's persona has always called itself "your personal AI matchmaker",
 * but every tool it had edited profile fields — so the two questions a
 * matchmaker actually exists to answer were the two it could not touch:
 * "why aren't I getting matched?" and "why this person?".
 *
 * Both answers are already computed and stored; nothing here derives anything
 * new. `standbyCount`, `embeddingDirty` and the photo count decide whether a
 * user even enters the drop batch, and `match_score_logs` freezes the full
 * per-pair score breakdown at creation time — until now readable only from the
 * admin dashboard. This module hands those to the agent as plain facts, and
 * nothing in it can write.
 */

// ---------------------------------------------------------------------------
// Standing — "why am I not being matched?"
// ---------------------------------------------------------------------------

export interface MatchmakingStanding {
  accountStatus: string;
  verificationStatus: string;
  /** Consecutive drop batches this user was eligible for but went unpaired. */
  missedBatches: number;
  /**
   * The same standby streak in wall-clock days — the only unit that means
   * anything to a user, and the one the agent must speak in.
   *
   * `missedBatches` is a count of CYCLES, so its scale moves with the cadence:
   * under `weekly` "2" is a fortnight, under `daily` "5" is five evenings. An
   * agent handed the raw count says "five drops in a row without a match",
   * which sounds like a verdict and describes less than a week of ordinary
   * waiting.
   */
  daysWaiting: number;
  /** True while the profile is excluded from matching pending an embedding rebuild. */
  profileSyncPending: boolean;
  photoCount: number;
  minPhotos: number;
  /** Photos needed for the one-time bonus ticket, or null once claimed/off. */
  photosForBonusTicket: number | null;
  hasPartnerPreferences: boolean;
  datingCity: string | null;
  /** Coarse bucket of same-city active candidates who could match this user. */
  cityPool: "none" | "very_small" | "small" | "healthy" | "unknown";
  lastMatchedAt: Date | null;
}

/** Buckets rather than a number: the exact pool size is not the user's business. */
function bucketPool(count: number): MatchmakingStanding["cityPool"] {
  if (count <= 0) return "none";
  if (count < 5) return "very_small";
  if (count < 20) return "small";
  return "healthy";
}

/** The genders this user's stated preference admits. */
function preferredGenders(preference: string | null): Array<"male" | "female"> {
  if (preference === "men") return ["male"];
  if (preference === "women") return ["female"];
  if (preference === "both") return ["male", "female"];
  return [];
}

export async function getMatchmakingStanding(
  telegramId: bigint,
): Promise<MatchmakingStanding | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      status: true,
      gender: true,
      preference: true,
      verificationStatus: true,
      profile: {
        select: {
          photos: true,
          partnerPreferences: true,
          embeddingDirty: true,
          standbyCount: true,
          missedWeeks: true,
          lastMatchedAt: true,
          homeCity: true,
          homeCityKey: true,
          photoBonusTicketAt: true,
        },
      },
    },
  });
  if (!user) return null;

  const profile = user.profile;
  const photoCount = profile?.photos?.length ?? 0;
  const wants = preferredGenders(user.preference);

  // Who could plausibly match this user in their own city: active, past the
  // gate, and looking for this user's gender. Mirrors the shape of the real
  // candidate query without any of its per-pair filters — it answers "is there
  // anybody here", not "who".
  let cityPool: MatchmakingStanding["cityPool"] = "unknown";
  if (profile?.homeCityKey && user.gender && wants.length > 0) {
    const count = await prisma.user.count({
      where: {
        id: { not: user.id },
        status: "active",
        onboardingStep: "completed",
        gender: { in: wants },
        preference: { in: user.gender === "male" ? ["men", "both"] : ["women", "both"] },
        profile: { homeCityKey: profile.homeCityKey },
      },
    });
    cityPool = bucketPool(count);
  }

  const missedBatches = profile?.standbyCount ?? profile?.missedWeeks ?? 0;

  return {
    accountStatus: user.status,
    verificationStatus: user.verificationStatus,
    missedBatches,
    daysWaiting: Math.round((missedBatches * CADENCE.intervalMs) / 86_400_000),
    profileSyncPending: profile?.embeddingDirty === true,
    photoCount,
    minPhotos: MIN_PHOTOS,
    photosForBonusTicket:
      profile?.photoBonusTicketAt || photoCount >= PHOTO_BONUS_TICKET_THRESHOLD
        ? null
        : PHOTO_BONUS_TICKET_THRESHOLD - photoCount,
    hasPartnerPreferences: Boolean(profile?.partnerPreferences?.trim()),
    datingCity: profile?.homeCity ?? null,
    cityPool,
    lastMatchedAt: profile?.lastMatchedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Match explanation — "why this person?"
// ---------------------------------------------------------------------------

export interface MatchExplanation {
  partnerFirstName: string | null;
  matchStatus: string;
  synergyScore: number | null;
  /** This side's own rationale sentence, in this side's language. */
  synergyReason: string | null;
  /** Qualitative labels, never the raw multipliers — see `describeFactor`. */
  factors: {
    psychologicalFit: string;
    lifestyleFit: string;
    attractivenessBalance: string;
    agePreferenceFit: string;
    priorityBoost: boolean;
    hadNegativeSignal: boolean;
  } | null;
}

/**
 * Turn a 0..1 score into a word.
 *
 * Deliberately qualitative. The raw numbers are internal mechanics (Elo
 * distance, cosine similarity) that would be read as a rating of the partner —
 * "your league multiplier was 0.4" is both meaningless and insulting. The bands
 * are wide enough that no exact value can be reconstructed from them.
 */
function describeFactor(score: number): string {
  if (score >= 0.85) return "very strong";
  if (score >= 0.7) return "strong";
  if (score >= 0.5) return "moderate";
  if (score >= 0.3) return "modest";
  return "weak";
}

/**
 * Explain the pairing the user is asking about — their live match, or their
 * most recent one when nothing is live (the question usually arrives right
 * after a match ends). Returns null when there is nothing to explain or the
 * pair predates score logging.
 */
export async function explainMatch(telegramId: bigint): Promise<MatchExplanation | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return null;

  const match = await prisma.match.findFirst({
    where: { OR: [{ userAId: user.id }, { userBId: user.id }] },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      status: true,
      userAId: true,
      synergyScore: true,
      synergyReason: true,
      synergyReasonB: true,
      userA: { select: { firstName: true } },
      userB: { select: { firstName: true } },
      scoreLog: {
        select: {
          scoreExplicit: true,
          scoreResearch: true,
          scoreLeague: true,
          scoreAgePref: true,
          scorePenalty: true,
          starvationBonus: true,
        },
      },
    },
  });
  if (!match) return null;

  const isA = match.userAId === user.id;
  const log = match.scoreLog;

  return {
    partnerFirstName: (isA ? match.userB?.firstName : match.userA?.firstName) ?? null,
    matchStatus: match.status,
    synergyScore: match.synergyScore ?? null,
    // Per-side rationale, each written in that side's own language; legacy rows
    // carry only side A's, which is the documented fallback.
    synergyReason: (isA ? match.synergyReason : match.synergyReasonB ?? match.synergyReason) ?? null,
    factors: log
      ? {
          psychologicalFit: describeFactor(log.scoreExplicit),
          lifestyleFit: describeFactor(log.scoreResearch),
          attractivenessBalance: describeFactor(log.scoreLeague),
          agePreferenceFit: describeFactor(log.scoreAgePref),
          priorityBoost: log.starvationBonus > 0,
          hadNegativeSignal: log.scorePenalty > 0,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Photo review — "which of my photos is letting me down?"
// ---------------------------------------------------------------------------

/**
 * How far above the accepted floor a photo still counts as hard to recognise.
 *
 * Every stored score already cleared `FACE_SIMILARITY_THRESHOLD` — the upload
 * gate rejects the rest — so an absolute "bad" band would be empty by
 * construction. The band that carries information is the one just above the
 * floor: a photo that only barely matched is one where the face is small,
 * turned away, shaded or shared with other people, and that is precisely the
 * photo worth replacing.
 */
const FACE_MATCH_WEAK_MARGIN = 0.1;

/**
 * Minimum spread between the best- and worst-scoring stored photo before the
 * pair is worth naming at all. Within a few points the ordering is model
 * noise, and "your fourth photo is the weakest one" said about noise is advice
 * the user can act on and be wrong.
 */
const STANDOUT_MIN_SPREAD = 8;

export interface PhotoReview {
  photoCount: number;
  minPhotos: number;
  maxPhotos: number;
  /**
   * Accepted static photos that have not yet formed the 2+ photo identity
   * cluster. They are uploaded but invisible — nobody sees them and they do
   * not count toward the minimum, which is otherwise a silent state.
   */
  pendingIdentityCheck: number;
  /** 1-based positions where the face is measurably harder to match. */
  hardToRecognise: number[];
  /** False for unverified users and legacy rows: no per-photo face data. */
  faceDataAvailable: boolean;
  /**
   * Ordinal standouts from the stored vision pass, or null when the stored
   * ranking cannot be trusted to still line up with the current photos.
   */
  standouts: { strongest: number; weakest: number } | null;
}

interface StoredPhotoScore {
  index: number;
  score: number;
}

/**
 * Narrow read of `Profile.eloSeedDetails`, which is a `Json?` column and so
 * arrives as `unknown`. Anything that deviates from the written shape is
 * treated as absent rather than repaired: a half-parsed ranking would still
 * produce a confident "replace photo 3".
 */
function parseSeedPhotos(raw: unknown): StoredPhotoScore[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const photos = (raw as { photos?: unknown }).photos;
  if (!Array.isArray(photos) || photos.length === 0) return null;

  const parsed: StoredPhotoScore[] = [];
  for (const entry of photos) {
    if (typeof entry !== "object" || entry === null) return null;
    const { index, score } = entry as { index?: unknown; score?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1) return null;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    parsed.push({ index, score });
  }
  return parsed;
}

/**
 * Read-only, per-photo review of the user's own profile photos.
 *
 * Nothing here runs a vision pass, and that is the whole point: the per-photo
 * numbers already exist. `Profile.eloSeedDetails.photos[]` keeps the score the
 * cold-start pass gave each individual photo, and `Profile.photoFaceScores[]`
 * keeps each photo's face-match similarity, written 1:1 with `photos[]` by the
 * upload gate. Reviewing photos is therefore a read, not an inference — an
 * earlier reading of this code concluded the opposite and deferred the feature
 * as needing new infrastructure (see DECISIONS.md).
 *
 * The two sources are not equally trustworthy over time, and they are guarded
 * differently:
 *
 *   - `photoFaceScores` is rewritten by the upload gate on every photo edit,
 *     so it is aligned with `photos[]` by construction. It is used whenever
 *     its length matches.
 *   - `eloSeedDetails` is frozen at seeding time and never revisited. Photos
 *     cannot be reordered in this product, so a set that has changed since the
 *     seed has either a different count (a removal) or a later `faceMatchedAt`
 *     (an upload). Failing either check drops the ranking entirely rather than
 *     renumbering it, because a stale ranking is not a weaker answer — it
 *     names the wrong photo.
 */
export async function getPhotoReview(telegramId: bigint): Promise<PhotoReview | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      faceMatchedAt: true,
      profile: {
        select: {
          photos: true,
          photoFaceScores: true,
          pendingPhotoCandidates: true,
          eloSeedDetails: true,
          eloSeededAt: true,
        },
      },
    },
  });
  if (!user) return null;

  const profile = user.profile;
  const photoCount = profile?.photos?.length ?? 0;
  const faceScores = profile?.photoFaceScores ?? [];
  // A length mismatch means the row predates per-photo scoring (or the user is
  // unverified). Positions cannot be inferred from a shorter list, so the
  // whole signal is withheld instead of being aligned by guesswork.
  const faceDataAvailable = faceScores.length > 0 && faceScores.length === photoCount;

  const hardToRecognise: number[] = [];
  if (faceDataAvailable) {
    faceScores.forEach((score, position) => {
      if (score < FACE_SIMILARITY_THRESHOLD + FACE_MATCH_WEAK_MARGIN) {
        hardToRecognise.push(position + 1);
      }
    });
  }

  return {
    photoCount,
    minPhotos: MIN_PHOTOS,
    maxPhotos: MAX_PHOTOS,
    pendingIdentityCheck: profile?.pendingPhotoCandidates?.length ?? 0,
    hardToRecognise,
    faceDataAvailable,
    standouts: standoutsFor(
      profile?.eloSeedDetails,
      photoCount,
      profile?.eloSeededAt ?? null,
      user.faceMatchedAt,
    ),
  };
}

function standoutsFor(
  seedDetails: unknown,
  photoCount: number,
  seededAt: Date | null,
  faceMatchedAt: Date | null,
): PhotoReview["standouts"] {
  // Naming a strongest and a weakest out of one photo says nothing.
  if (photoCount < 2 || !seededAt) return null;
  // A photo uploaded after the seed ran shifts every position after it.
  if (faceMatchedAt && faceMatchedAt.getTime() > seededAt.getTime()) return null;

  const stored = parseSeedPhotos(seedDetails);
  if (!stored || stored.length !== photoCount) return null;

  let strongest = stored[0]!;
  let weakest = stored[0]!;
  for (const entry of stored) {
    if (entry.score > strongest.score) strongest = entry;
    if (entry.score < weakest.score) weakest = entry;
  }
  if (strongest.score - weakest.score < STANDOUT_MIN_SPREAD) return null;
  if (strongest.index > photoCount || weakest.index > photoCount) return null;

  return { strongest: strongest.index, weakest: weakest.index };
}
