import { prisma } from "@gennety/db";

/**
 * Match engine — multi-factor candidate scoring.
 *
 * MatchScore = (w1 * V_explicit) + (w2 * V_visual) + (w3 * V_research) - (w4 * V_penalty)
 *
 * Strategy: **Hybrid SQL + Node.js re-ranking**.
 *   1. SQL pre-filter fetches a wide candidate pool (top N by embedding distance)
 *      with all hard constraints (university, gender, cooldown, no open matches).
 *   2. Node.js applies the full weighted formula and returns the top K.
 *
 * Correctness rules (enforced by `buildCandidateQuery`):
 *   1. Only `active` users with completed onboarding are considered.
 *   2. Only users with an embedding and `preference`/`gender` set are eligible.
 *   3. Mutual gender compatibility: a's preference must include b's gender
 *      AND b's preference must include a's gender.
 *   4. Same university domain (hyper-local student focus, per PRODUCT_SPEC).
 *   5. Lifetime ban: exclude any pair that appears in ANY historical Match
 *      row — regardless of terminal status (proposed, negotiating, scheduled,
 *      accepted, cancelled, completed, expired). A user never sees the same
 *      partner twice. Backed by the `matches_pair_canonical_idx` functional
 *      index on `LEAST/GREATEST(user_a_id, user_b_id)`.
 *   6. Cooldown: skip users whose `lastMatchedAt` is within MATCH_COOLDOWN_MS.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MATCH_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_CANDIDATE_LIMIT = 5;

/** Wider pool fetched from SQL before Node.js re-ranking. */
const CANDIDATE_POOL_SIZE = 20;

// ---------------------------------------------------------------------------
// Scoring weights — sum to 1.0 (penalty is subtracted, not added)
// ---------------------------------------------------------------------------

export const SCORING_WEIGHTS = {
  /** Semantic embedding similarity (cosine). */
  explicit: 0.40,
  /** Visual preference vector similarity. */
  visual: 0.20,
  /** Sociological baseline heuristics (height, age, social energy). */
  research: 0.10,
  /** Negative constraint penalty — subtracted from total. */
  penalty: 0.30,
} as const;

// ---------------------------------------------------------------------------
// Starvation priority — per-missed-week score bonus for unpaired users
// ---------------------------------------------------------------------------

/** Score boost per missed weekly batch. */
export const STARVATION_ALPHA = 0.05;
/**
 * Hard cap on the starvation bonus. Strictly below `SCORING_WEIGHTS.penalty`
 * (0.30) so a strong negative-constraint match still outweighs priority —
 * the bonus breaks ties, it doesn't force bad pairings.
 */
export const STARVATION_CAP = 0.25;

/**
 * Priority bonus for a user who has been eligible-but-unpaired for
 * `missedWeeks` consecutive batches. Linearly scaled by `STARVATION_ALPHA`,
 * capped at `STARVATION_CAP`. Non-starved users (0 or negative) return 0.
 */
export function starvationBonus(missedWeeks: number): number {
  if (missedWeeks <= 0) return 0;
  return Math.min(STARVATION_CAP, STARVATION_ALPHA * missedWeeks);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateRow {
  userId: string;
  telegramId: bigint;
  firstName: string | null;
  distance: number;
}

/** Extended candidate row fetched from the wide SQL pool for re-ranking. */
export interface RichCandidateRow extends CandidateRow {
  age: number | null;
  gender: string | null;
  height: number | null;
  major: string | null;
  psychologicalSummary: string | null;
  negativeConstraints: string | null;
  visualVector: number[];
  socialEnergy: string | null;
}

/** Seeker profile data needed for scoring. */
export interface SeekerProfile {
  age: number | null;
  gender: string | null;
  height: number | null;
  major: string | null;
  negativeConstraints: string | null;
  visualVector: number[];
  socialEnergy: string | null;
}

export interface ScoredCandidate {
  userId: string;
  telegramId: bigint;
  firstName: string | null;
  score: number;
  breakdown: {
    explicit: number;
    visual: number;
    research: number;
    penalty: number;
  };
}

// ---------------------------------------------------------------------------
// SQL — wide candidate pool
// ---------------------------------------------------------------------------

/**
 * Build the raw SQL used to fetch a wide candidate pool for re-ranking.
 *
 * Returns all columns needed for multi-factor scoring. The pool is sorted
 * by embedding distance ASC so the SQL pre-filter remains useful, but the
 * final ranking is done in Node.js.
 */
export function buildCandidateSql(): string {
  return `
    SELECT
      u.id                    AS "userId",
      u.telegram_id           AS "telegramId",
      u.first_name            AS "firstName",
      u.age                   AS "age",
      u.gender                AS "gender",
      u.major                 AS "major",
      p.height                AS "height",
      p.psychological_summary AS "psychologicalSummary",
      p.negative_constraints  AS "negativeConstraints",
      p.visual_vector         AS "visualVector",
      (p.embedding <=> $2::vector) AS distance
    FROM users u
    JOIN profiles p ON p.user_id = u.id
    WHERE u.id <> $1::uuid
      AND u.status = 'active'
      AND u.onboarding_step = 'completed'
      AND u.university_domain = $3
      AND p.embedding IS NOT NULL
      AND ($5 = '' OR u.gender::text = $5)
      AND (u.preference::text = 'both' OR u.preference::text = (
        CASE $4 WHEN 'male' THEN 'men' WHEN 'female' THEN 'women' ELSE '' END
      ))
      AND (p.last_matched_at IS NULL OR p.last_matched_at < $6)
      AND NOT EXISTS (
        SELECT 1 FROM matches m
         WHERE LEAST(m.user_a_id, m.user_b_id)    = LEAST($1::uuid, u.id)
           AND GREATEST(m.user_a_id, m.user_b_id) = GREATEST($1::uuid, u.id)
      )
    ORDER BY distance ASC
    LIMIT $7
  `;
}

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

/** Translate a `GenderPreference` to the single gender the SQL filter expects. */
export function preferenceToGenderFilter(
  preference: "men" | "women" | "both",
): "male" | "female" | "" {
  if (preference === "men") return "male";
  if (preference === "women") return "female";
  return "";
}

// ---------------------------------------------------------------------------
// Multi-factor scoring — pure functions
// ---------------------------------------------------------------------------

/**
 * Convert pgvector cosine distance (0 = identical, 2 = opposite) to a
 * 0..1 similarity score.
 */
export function explicitScore(distance: number): number {
  return Math.min(1, Math.max(0, 1 - distance / 2));
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 if either
 * vector is empty or zero-magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * V_visual: similarity between seeker's and candidate's visual vectors.
 * Returns 0..1 (1 = perfect match).
 */
export function visualScore(
  seekerVisualVec: number[],
  candidateVisualVec: number[],
): number {
  if (seekerVisualVec.length === 0 || candidateVisualVec.length === 0) return 0;
  // Clamp to [0,1] since visual vectors should already be positive.
  return Math.max(0, cosineSimilarity(seekerVisualVec, candidateVisualVec));
}

// ---------------------------------------------------------------------------
// V_penalty — negative constraints
// ---------------------------------------------------------------------------

/**
 * Parse `negativeConstraints` text into a flat list of lowercase traits.
 *
 * Expected format (produced by `appendNegativeConstraint`):
 *   - [type] summary [trait1, trait2]
 *   - plain text constraint
 *
 * Returns an array of individual trait strings for keyword matching.
 */
export function parseNegativeTraits(constraints: string | null): string[] {
  if (!constraints) return [];
  const traits: string[] = [];
  for (const line of constraints.split("\n")) {
    const trimmed = line.replace(/^-\s*/, "").trim().toLowerCase();
    if (!trimmed) continue;

    // Extract bracketed trait lists: [trait1, trait2]
    const bracketMatch = trimmed.match(/\[([^\]]+)\]\s*$/);
    if (bracketMatch) {
      for (const t of bracketMatch[1]!.split(",")) {
        const cleaned = t.trim();
        if (cleaned) traits.push(cleaned);
      }
    } else {
      // No bracket — use the whole line as a trait keyword
      traits.push(trimmed);
    }
  }
  return traits;
}

/**
 * V_penalty: check how many of the seeker's negative-constraint traits
 * appear in the candidate's psychological summary. Returns 0..1 where
 * 1 = maximum penalty (all traits matched).
 */
export function penaltyScore(
  seekerConstraints: string | null,
  candidateSummary: string | null,
): number {
  const traits = parseNegativeTraits(seekerConstraints);
  if (traits.length === 0) return 0;
  if (!candidateSummary) return 0;

  const summaryLower = candidateSummary.toLowerCase();
  let hits = 0;
  for (const trait of traits) {
    if (summaryLower.includes(trait)) {
      hits++;
    }
  }
  return hits / traits.length;
}

// ---------------------------------------------------------------------------
// V_research — sociological heuristics
// ---------------------------------------------------------------------------

/**
 * Extract social energy from a psychological summary string.
 * Looks for keywords: introvert, extrovert, ambivert.
 */
export function extractSocialEnergy(
  summary: string | null,
): "introvert" | "extrovert" | "ambivert" | null {
  if (!summary) return null;
  const lower = summary.toLowerCase();
  if (lower.includes("introvert")) return "introvert";
  if (lower.includes("extrovert")) return "extrovert";
  if (lower.includes("ambivert")) return "ambivert";
  return null;
}

/**
 * Height norm score for a male/female pair.
 *
 * Sweet spot: male is 5–12 cm taller → 1.0.
 * Taller but outside sweet spot → 0.7.
 * Male shorter than female → 0.2 (heavy penalty).
 * Equal height → 0.5.
 */
export function heightNormScore(maleHeight: number, femaleHeight: number): number {
  const diff = maleHeight - femaleHeight;
  if (diff >= 5 && diff <= 12) return 1.0;
  if (diff > 12) return 0.7;
  if (diff > 0 && diff < 5) return 0.6;
  if (diff === 0) return 0.5;
  // Male is shorter
  return 0.2;
}

/**
 * Age gradient score for a pair.
 *
 * Same age or male 1–2 years older → 1.0 (bonus).
 * Age gap exactly 3 → 0.6 (soft penalty).
 * Age gap > 3 → linear decay from 0.4 down to 0 at gap 10.
 *
 * For M/F pairs the direction matters: male-older is preferred.
 * For same-gender pairs only absolute distance is used.
 */
export function ageGradientScore(
  seekerAge: number,
  candidateAge: number,
  seekerGender: string | null,
  candidateGender: string | null,
): number {
  const isMFPair =
    (seekerGender === "female" && candidateGender === "male") ||
    (seekerGender === "male" && candidateGender === "female");

  if (isMFPair) {
    const maleAge = seekerGender === "male" ? seekerAge : candidateAge;
    const femaleAge = seekerGender === "female" ? seekerAge : candidateAge;
    const signedDiff = maleAge - femaleAge; // positive = male older

    if (signedDiff >= 0 && signedDiff <= 2) return 1.0;
    const gap = Math.abs(signedDiff);
    if (gap === 3) return 0.6;
    if (gap >= 10) return 0.0;
    // Linear decay from 0.4 at gap=4 to 0 at gap=10
    return Math.max(0, 0.4 - (gap - 4) * (0.4 / 6));
  }

  // Same-gender or unknown — symmetric absolute distance
  const diff = Math.abs(seekerAge - candidateAge);
  if (diff <= 2) return 1.0;
  if (diff === 3) return 0.6;
  if (diff >= 10) return 0.0;
  return Math.max(0, 0.4 - (diff - 4) * (0.4 / 6));
}

// ---------------------------------------------------------------------------
// Educational homogamy
// ---------------------------------------------------------------------------

/** Broad academic clusters for major grouping. */
const MAJOR_CLUSTERS: Record<string, string[]> = {
  stem: [
    "computer science", "cs", "mathematics", "math", "physics", "engineering",
    "electrical engineering", "mechanical engineering", "chemistry", "biology",
    "statistics", "data science", "information technology", "it",
  ],
  humanities: [
    "history", "philosophy", "literature", "english", "linguistics",
    "cultural studies", "classics", "religious studies", "sociology",
    "anthropology", "political science", "psychology",
  ],
  arts: [
    "art", "fine arts", "music", "theater", "film", "design",
    "graphic design", "photography", "architecture",
  ],
  business: [
    "business", "economics", "finance", "accounting", "marketing",
    "management", "mba", "entrepreneurship", "international business",
  ],
  health: [
    "medicine", "nursing", "public health", "pharmacy", "dentistry",
    "kinesiology", "nutrition", "biomedical",
  ],
};

/** Lazily built reverse lookup: normalised major → cluster name. */
let _majorToCluster: Map<string, string> | null = null;

function majorToCluster(): Map<string, string> {
  if (!_majorToCluster) {
    _majorToCluster = new Map();
    for (const [cluster, majors] of Object.entries(MAJOR_CLUSTERS)) {
      for (const m of majors) {
        _majorToCluster.set(m, cluster);
      }
    }
  }
  return _majorToCluster;
}

/** Resolve a free-text major to its cluster, or `null` if unrecognised. */
export function resolveCluster(major: string | null): string | null {
  if (!major) return null;
  const norm = major.trim().toLowerCase();
  const exact = majorToCluster().get(norm);
  if (exact) return exact;
  // Substring match — e.g. "computer science and engineering" → stem
  for (const [key, cluster] of majorToCluster()) {
    if (norm.includes(key) || key.includes(norm)) return cluster;
  }
  return null;
}

/**
 * Educational homogamy score.
 *   Same major (exact normalised match) → 1.0
 *   Same cluster (e.g. STEM + STEM)     → 0.7
 *   Cross-cluster                        → 0.3
 *   Missing data                         → 0.5 (neutral)
 */
export function majorSimilarityScore(
  seekerMajor: string | null,
  candidateMajor: string | null,
): number {
  if (!seekerMajor || !candidateMajor) return 0.5;
  const a = seekerMajor.trim().toLowerCase();
  const b = candidateMajor.trim().toLowerCase();
  if (a === b) return 1.0;
  const clusterA = resolveCluster(seekerMajor);
  const clusterB = resolveCluster(candidateMajor);
  if (clusterA && clusterB && clusterA === clusterB) return 0.7;
  return 0.3;
}

// ---------------------------------------------------------------------------
// V_research — composite sociological heuristics
// ---------------------------------------------------------------------------

/**
 * V_research: baseline sociological modifiers. Returns 0..1.
 *
 * Sub-factors (equally weighted):
 *   1. Height norm: bonus if male is 5–12 cm taller; penalty if shorter.
 *   2. Age gradient: bonus for same-age / male 1–2yr older; penalty > 3yr gap.
 *   3. Social energy compatibility: same energy level gets a boost.
 *   4. Educational homogamy: same major / same cluster bonus.
 */
export function researchScore(
  seeker: { age: number | null; gender: string | null; height: number | null; socialEnergy: string | null; major?: string | null },
  candidate: { age: number | null; gender: string | null; height: number | null; socialEnergy: string | null; major?: string | null },
): number {
  let total = 0;
  let factors = 0;

  // 1. Height norm
  if (seeker.height != null && candidate.height != null) {
    factors++;
    const seekerIsFemale = seeker.gender === "female";
    const candidateIsMale = candidate.gender === "male";
    if (seekerIsFemale && candidateIsMale) {
      total += heightNormScore(candidate.height, seeker.height);
    } else if (seeker.gender === "male" && candidate.gender === "female") {
      total += heightNormScore(seeker.height, candidate.height);
    } else {
      // Same gender — height is neutral
      total += 0.5;
    }
  }

  // 2. Age gradient
  if (seeker.age != null && candidate.age != null) {
    factors++;
    total += ageGradientScore(seeker.age, candidate.age, seeker.gender, candidate.gender);
  }

  // 3. Social energy compatibility
  if (seeker.socialEnergy && candidate.socialEnergy) {
    factors++;
    if (seeker.socialEnergy === candidate.socialEnergy) {
      total += 1.0;
    } else if (
      seeker.socialEnergy === "ambivert" || candidate.socialEnergy === "ambivert"
    ) {
      total += 0.6; // Ambivert is moderately compatible with anyone
    } else {
      total += 0.2; // introvert-extrovert mismatch
    }
  }

  // 4. Educational homogamy
  if (seeker.major || candidate.major) {
    factors++;
    total += majorSimilarityScore(seeker.major ?? null, candidate.major ?? null);
  }

  if (factors === 0) return 0.5; // Neutral when no data available
  return total / factors;
}

// ---------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------

/**
 * Compute the full multi-factor match score for a single candidate.
 * All sub-scores are 0..1; the composite score can go negative if
 * penalty is high enough (such candidates are ranked last).
 */
export function scoreCandidate(
  seeker: SeekerProfile,
  candidate: RichCandidateRow,
  weights = SCORING_WEIGHTS,
): ScoredCandidate {
  const vExplicit = explicitScore(candidate.distance);
  const vVisual = visualScore(seeker.visualVector, candidate.visualVector);
  const vResearch = researchScore(
    {
      age: seeker.age,
      gender: seeker.gender,
      height: seeker.height,
      socialEnergy: seeker.socialEnergy,
      major: seeker.major,
    },
    {
      age: candidate.age,
      gender: candidate.gender,
      height: candidate.height,
      socialEnergy: extractSocialEnergy(candidate.psychologicalSummary),
      major: candidate.major,
    },
  );
  const vPenalty = penaltyScore(
    seeker.negativeConstraints,
    candidate.psychologicalSummary,
  );

  const score =
    weights.explicit * vExplicit +
    weights.visual * vVisual +
    weights.research * vResearch -
    weights.penalty * vPenalty;

  return {
    userId: candidate.userId,
    telegramId: candidate.telegramId,
    firstName: candidate.firstName,
    score,
    breakdown: {
      explicit: vExplicit,
      visual: vVisual,
      research: vResearch,
      penalty: vPenalty,
    },
  };
}

/**
 * Score and rank an array of candidates. Returns sorted descending by score.
 */
export function rankCandidates(
  seeker: SeekerProfile,
  candidates: RichCandidateRow[],
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): ScoredCandidate[] {
  return candidates
    .map((c) => scoreCandidate(seeker, c))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/**
 * Fetch up to `CANDIDATE_POOL_SIZE` candidates from SQL, then re-rank
 * using the multi-factor formula and return the top `limit`.
 */
export async function findCandidatesFor(
  seekerUserId: string,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): Promise<ScoredCandidate[]> {
  const seeker = await prisma.user.findUnique({
    where: { id: seekerUserId },
    select: {
      id: true,
      age: true,
      gender: true,
      major: true,
      preference: true,
      universityDomain: true,
      status: true,
      onboardingStep: true,
      profile: {
        select: {
          height: true,
          negativeConstraints: true,
          visualVector: true,
          psychologicalSummary: true,
        },
      },
    },
  });
  if (
    !seeker ||
    seeker.status !== "active" ||
    seeker.onboardingStep !== "completed" ||
    !seeker.gender ||
    !seeker.preference ||
    !seeker.universityDomain
  ) {
    return [];
  }

  // Pull the seeker embedding via raw SQL (pgvector is `Unsupported` in Prisma).
  const embeddingRows = await prisma.$queryRawUnsafe<Array<{ embedding: string | null }>>(
    `SELECT embedding::text AS embedding FROM profiles WHERE user_id = $1::uuid`,
    seekerUserId,
  );
  const embeddingLiteral = embeddingRows[0]?.embedding;
  if (!embeddingLiteral) return [];

  const cutoff = new Date(Date.now() - MATCH_COOLDOWN_MS);
  const genderFilter = preferenceToGenderFilter(seeker.preference);

  const pool = await prisma.$queryRawUnsafe<RichCandidateRow[]>(
    buildCandidateSql(),
    seekerUserId,
    embeddingLiteral,
    seeker.universityDomain,
    seeker.gender,
    genderFilter,
    cutoff,
    CANDIDATE_POOL_SIZE,
  );

  const seekerProfile: SeekerProfile = {
    age: seeker.age,
    gender: seeker.gender,
    height: seeker.profile?.height ?? null,
    major: seeker.major ?? null,
    negativeConstraints: seeker.profile?.negativeConstraints ?? null,
    visualVector: seeker.profile?.visualVector ?? [],
    socialEnergy: extractSocialEnergy(seeker.profile?.psychologicalSummary ?? null),
  };

  return rankCandidates(seekerProfile, pool, limit);
}

// ---------------------------------------------------------------------------
// Match creation
// ---------------------------------------------------------------------------

/**
 * Create a `Match` row for the given pair in `proposed` state, and bump
 * `lastMatchedAt` on both profiles so the cooldown takes effect.
 */
export async function createProposedMatch(
  userAId: string,
  userBId: string,
): Promise<{ id: string }> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: { userAId, userBId, status: "proposed" },
      select: { id: true },
    });
    await tx.profile.updateMany({
      where: { userId: { in: [userAId, userBId] } },
      data: { lastMatchedAt: now },
    });
    return match;
  });
}

// ---------------------------------------------------------------------------
// Orchestration — Weekly Batch (Global Greedy)
// ---------------------------------------------------------------------------

export interface WeeklyBatchResult {
  eligible: number;
  pairs: number;
  matchIds: string[];
  /** Users who were eligible for this batch but left unpaired — their
   *  `Profile.missedWeeks` was just incremented. Consumed by the UX ping. */
  missedUserIds: string[];
}

/** Full user row fetched in the batch pre-load. */
export interface BatchUser {
  id: string;
  age: number | null;
  gender: string | null;
  major: string | null;
  preference: string | null;
  universityDomain: string | null;
  height: number | null;
  negativeConstraints: string | null;
  visualVector: number[];
  psychologicalSummary: string | null;
  embeddingLiteral: string | null;
  /** Consecutive batches this user has been eligible but unpaired. */
  missedWeeks: number;
}

/** A scored pair produced by the global scoring phase. */
export interface ScoredPair {
  userAId: string;
  userBId: string;
  score: number;
}

/**
 * Check mutual gender compatibility between two users.
 * a's preference must include b's gender AND b's preference must include a's gender.
 */
export function areMutuallyCompatible(a: BatchUser, b: BatchUser): boolean {
  if (!a.gender || !b.gender || !a.preference || !b.preference) return false;
  if (a.universityDomain !== b.universityDomain) return false;

  const aWantsB =
    a.preference === "both" ||
    (a.preference === "men" && b.gender === "male") ||
    (a.preference === "women" && b.gender === "female");

  const bWantsA =
    b.preference === "both" ||
    (b.preference === "men" && a.gender === "male") ||
    (b.preference === "women" && a.gender === "female");

  return aWantsB && bWantsA;
}

/**
 * Score a pair of BatchUsers using the existing multi-factor formula.
 * Requires the embedding distance to be pre-computed via SQL.
 */
export function scorePair(
  a: BatchUser,
  b: BatchUser,
  embeddingDistance: number,
): number {
  const seekerA: SeekerProfile = {
    age: a.age,
    gender: a.gender,
    height: a.height,
    major: a.major,
    negativeConstraints: a.negativeConstraints,
    visualVector: a.visualVector,
    socialEnergy: extractSocialEnergy(a.psychologicalSummary),
  };

  const candidateB: RichCandidateRow = {
    userId: b.id,
    telegramId: 0n,
    firstName: null,
    distance: embeddingDistance,
    age: b.age,
    gender: b.gender,
    height: b.height,
    major: b.major,
    psychologicalSummary: b.psychologicalSummary,
    negativeConstraints: b.negativeConstraints,
    visualVector: b.visualVector,
    socialEnergy: extractSocialEnergy(b.psychologicalSummary),
  };

  const scored = scoreCandidate(seekerA, candidateB);

  // Average with the reverse direction so the score is symmetric.
  const seekerB: SeekerProfile = {
    age: b.age,
    gender: b.gender,
    height: b.height,
    major: b.major,
    negativeConstraints: b.negativeConstraints,
    visualVector: b.visualVector,
    socialEnergy: extractSocialEnergy(b.psychologicalSummary),
  };

  const candidateA: RichCandidateRow = {
    userId: a.id,
    telegramId: 0n,
    firstName: null,
    distance: embeddingDistance,
    age: a.age,
    gender: a.gender,
    height: a.height,
    major: a.major,
    psychologicalSummary: a.psychologicalSummary,
    negativeConstraints: a.negativeConstraints,
    visualVector: a.visualVector,
    socialEnergy: extractSocialEnergy(a.psychologicalSummary),
  };

  const scoredReverse = scoreCandidate(seekerB, candidateA);

  const base = (scored.score + scoredReverse.score) / 2;
  // Starvation priority: boost the pair by the MAX of each side's bonus,
  // never the sum — two starved users shouldn't stack priority and pair
  // off with each other at the expense of fresh users.
  const bonus = Math.max(starvationBonus(a.missedWeeks), starvationBonus(b.missedWeeks));
  return base + bonus;
}

/**
 * Greedy pairing: walk down the score-sorted list and pair the top-scoring
 * couple, removing both from the pool, then continue.
 */
export function greedyPair(scoredPairs: ScoredPair[]): ScoredPair[] {
  const sorted = [...scoredPairs].sort((a, b) => b.score - a.score);
  const paired = new Set<string>();
  const result: ScoredPair[] = [];

  for (const pair of sorted) {
    if (paired.has(pair.userAId) || paired.has(pair.userBId)) continue;
    result.push(pair);
    paired.add(pair.userAId);
    paired.add(pair.userBId);
  }

  return result;
}

/**
 * Flip any `suspended` users whose `suspendedUntil` has elapsed back to
 * `active`. Runs at the top of each batch tick so the 14-day Tier 2
 * suspension auto-unfreezes without a dedicated worker.
 */
export async function autoUnsuspendElapsed(
  now: Date = new Date(),
): Promise<number> {
  const result = await prisma.user.updateMany({
    where: {
      status: "suspended",
      suspendedUntil: { lte: now },
    },
    data: { status: "active", suspendedUntil: null },
  });
  return result.count;
}

/**
 * Load all eligible users for batch matching. Returns users with active
 * status, completed onboarding, valid profile data, and embeddings.
 */
export async function loadEligibleUsers(): Promise<BatchUser[]> {
  const cutoff = new Date(Date.now() - MATCH_COOLDOWN_MS);

  const users = await prisma.user.findMany({
    where: {
      status: "active",
      onboardingStep: "completed",
      gender: { not: null },
      preference: { not: null },
      universityDomain: { not: null },
      profile: {
        lastMatchedAt: { lt: cutoff },
      },
    },
    select: {
      id: true,
      age: true,
      gender: true,
      major: true,
      preference: true,
      universityDomain: true,
      profile: {
        select: {
          height: true,
          negativeConstraints: true,
          visualVector: true,
          psychologicalSummary: true,
          missedWeeks: true,
        },
      },
    },
  });

  // Also include users whose profile has no lastMatchedAt (never matched).
  const neverMatched = await prisma.user.findMany({
    where: {
      status: "active",
      onboardingStep: "completed",
      gender: { not: null },
      preference: { not: null },
      universityDomain: { not: null },
      profile: {
        lastMatchedAt: null,
      },
    },
    select: {
      id: true,
      age: true,
      gender: true,
      major: true,
      preference: true,
      universityDomain: true,
      profile: {
        select: {
          height: true,
          negativeConstraints: true,
          visualVector: true,
          psychologicalSummary: true,
          missedWeeks: true,
        },
      },
    },
  });

  const allUsers = [...users, ...neverMatched];
  const uniqueIds = new Set<string>();
  const deduped = allUsers.filter((u) => {
    if (uniqueIds.has(u.id)) return false;
    uniqueIds.add(u.id);
    return true;
  });

  // Batch-fetch embeddings for all users (pgvector is Unsupported in Prisma).
  const ids = deduped.map((u) => u.id);
  if (ids.length === 0) return [];

  const embeddingRows = await prisma.$queryRawUnsafe<
    Array<{ user_id: string; embedding: string | null }>
  >(
    `SELECT user_id, embedding::text AS embedding FROM profiles WHERE user_id = ANY($1::uuid[])`,
    ids,
  );
  const embeddingMap = new Map<string, string | null>();
  for (const row of embeddingRows) {
    embeddingMap.set(row.user_id, row.embedding);
  }

  return deduped
    .filter((u) => embeddingMap.get(u.id)) // Must have an embedding
    .map((u) => ({
      id: u.id,
      age: u.age,
      gender: u.gender,
      major: u.major,
      preference: u.preference,
      universityDomain: u.universityDomain,
      height: u.profile?.height ?? null,
      negativeConstraints: u.profile?.negativeConstraints ?? null,
      visualVector: u.profile?.visualVector ?? [],
      psychologicalSummary: u.profile?.psychologicalSummary ?? null,
      embeddingLiteral: embeddingMap.get(u.id) ?? null,
      missedWeeks: u.profile?.missedWeeks ?? 0,
    }));
}

/**
 * Compute embedding distances between all eligible pairs via a single SQL
 * call. Returns a Map keyed by "userAId:userBId" → distance.
 */
export async function computePairwiseDistances(
  users: BatchUser[],
): Promise<Map<string, number>> {
  const distances = new Map<string, number>();
  if (users.length < 2) return distances;

  // Build a batch SQL query: for each pair compute cosine distance.
  // We chunk to avoid extremely large queries.
  const pairs: Array<{ aId: string; bId: string; aEmb: string; bEmb: string }> = [];
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const a = users[i]!;
      const b = users[j]!;
      if (!areMutuallyCompatible(a, b)) continue;
      if (!a.embeddingLiteral || !b.embeddingLiteral) continue;
      pairs.push({ aId: a.id, bId: b.id, aEmb: a.embeddingLiteral, bEmb: b.embeddingLiteral });
    }
  }

  // Process in chunks of 500 to keep SQL query size reasonable.
  const CHUNK_SIZE = 500;
  for (let offset = 0; offset < pairs.length; offset += CHUNK_SIZE) {
    const chunk = pairs.slice(offset, offset + CHUNK_SIZE);
    const unionParts = chunk.map(
      (p, idx) =>
        `SELECT '${p.aId}' AS a_id, '${p.bId}' AS b_id, ($${idx * 2 + 1}::vector <=> $${idx * 2 + 2}::vector) AS distance`,
    );
    const sql = unionParts.join(" UNION ALL ");
    const params = chunk.flatMap((p) => [p.aEmb, p.bEmb]);

    const rows = await prisma.$queryRawUnsafe<
      Array<{ a_id: string; b_id: string; distance: number }>
    >(sql, ...params);

    for (const row of rows) {
      distances.set(`${row.a_id}:${row.b_id}`, Number(row.distance));
    }
  }

  return distances;
}

/**
 * Load every historical match pair touching the given users — regardless of
 * terminal status. Enforces the lifetime ban: once two users have been
 * matched, they are never matched again.
 */
async function loadHistoricalMatchPairs(
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const matches = await prisma.match.findMany({
    where: {
      OR: [
        { userAId: { in: userIds } },
        { userBId: { in: userIds } },
      ],
    },
    select: { userAId: true, userBId: true },
  });

  const pairKeys = new Set<string>();
  for (const m of matches) {
    pairKeys.add(`${m.userAId}:${m.userBId}`);
    pairKeys.add(`${m.userBId}:${m.userAId}`);
  }
  return pairKeys;
}

/**
 * Weekly batch: global greedy matching algorithm.
 *
 * 1. Load all eligible users with embeddings in one batch.
 * 2. Compute pairwise embedding distances via SQL.
 * 3. Score all compatible pairs using the multi-factor formula.
 * 4. Greedy-pair: highest score first, remove both from pool, repeat.
 * 5. Create Match rows for all pairs.
 *
 * Returns match IDs for the dispatch queue to process.
 */
export async function runWeeklyBatch(): Promise<WeeklyBatchResult> {
  await autoUnsuspendElapsed();
  const users = await loadEligibleUsers();
  if (users.length < 2) {
    return { eligible: users.length, pairs: 0, matchIds: [], missedUserIds: [] };
  }

  const userIds = users.map((u) => u.id);
  const historicalPairs = await loadHistoricalMatchPairs(userIds);

  const userMap = new Map<string, BatchUser>();
  for (const u of users) {
    userMap.set(u.id, u);
  }

  const distances = await computePairwiseDistances(users);

  // Score all valid pairs.
  const scoredPairs: ScoredPair[] = [];
  for (const [key, distance] of distances) {
    const [aId, bId] = key.split(":");
    if (!aId || !bId) continue;

    // Skip pairs that have ever been matched before (lifetime ban).
    if (historicalPairs.has(`${aId}:${bId}`)) continue;

    const a = userMap.get(aId);
    const b = userMap.get(bId);
    if (!a || !b) continue;

    const score = scorePair(a, b, distance);
    scoredPairs.push({ userAId: aId, userBId: bId, score });
  }

  // Greedy pairing.
  const finalPairs = greedyPair(scoredPairs);

  // Create match rows.
  const matchIds: string[] = [];
  for (const pair of finalPairs) {
    const match = await createProposedMatch(pair.userAId, pair.userBId);
    matchIds.push(match.id);
  }

  // Diff eligible-vs-paired and update starvation counters.
  const pairedIds = new Set<string>();
  for (const p of finalPairs) {
    pairedIds.add(p.userAId);
    pairedIds.add(p.userBId);
  }
  const missedUserIds = users.filter((u) => !pairedIds.has(u.id)).map((u) => u.id);
  const pairedUserIds = [...pairedIds];
  const now = new Date();

  await prisma.$transaction([
    prisma.profile.updateMany({
      where: { userId: { in: pairedUserIds } },
      data: { missedWeeks: 0 },
    }),
    prisma.profile.updateMany({
      where: { userId: { in: missedUserIds } },
      data: { missedWeeks: { increment: 1 }, lastMissedAt: now },
    }),
  ]);

  console.log(
    `[weekly-batch] eligible=${users.length} scored=${scoredPairs.length} pairs=${finalPairs.length} missed=${missedUserIds.length}`,
  );

  return {
    eligible: users.length,
    pairs: finalPairs.length,
    matchIds,
    missedUserIds,
  };
}
