import { prisma } from "@gennety/db";
import { MIN_PHOTOS, PHOTO_BONUS_TICKET_THRESHOLD } from "@gennety/shared";

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

  return {
    accountStatus: user.status,
    verificationStatus: user.verificationStatus,
    missedBatches: profile?.standbyCount ?? profile?.missedWeeks ?? 0,
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
