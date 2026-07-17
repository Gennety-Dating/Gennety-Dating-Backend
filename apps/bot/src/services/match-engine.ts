import { prisma } from "@gennety/db";
import { ACTIVE_MATCH_STATUSES } from "./active-match-priority.js";

/**
 * Match engine — multi-factor candidate scoring.
 *
 * MatchScore = ((w1 * V_explicit) + (w2 * V_research)) * V_league - (w3 * V_penalty)
 *
 * Strategy: **Hybrid SQL + Node.js re-ranking**.
 *   1. SQL pre-filter fetches a wide candidate pool (top N by embedding distance)
 *      with all hard constraints (dating city, gender, cooldown, no open matches).
 *   2. Node.js applies the full weighted formula and returns the top K.
 *
 * `V_league` (universal Elo distance) gates positive score *before* the
 * negative-constraint penalty so penalty cannot be amplified or diluted by
 * the league multiplier — only the positive signal is league-gated.
 *
 * Correctness rules (enforced by `buildCandidateQuery`):
 *   1. Only `active` users with completed onboarding are considered.
 *   2. Only users with an embedding and `preference`/`gender` set are eligible.
 *   3. Mutual gender compatibility: a's preference must include b's gender
 *      AND b's preference must include a's gender.
 *   4. Same dating city (`Profile.homeCityKey`) while keeping a verified
 *      contact rail as the trust gate — a verified university/corporate
 *      email OR a verified phone (Registration v2 general track). Legacy
 *      users are all email-verified, so the union is a strict superset of
 *      the old email-only rule.
 *   5. Lifetime ban: exclude any pair that appears in ANY historical Match
 *      row — regardless of terminal status (proposed, negotiating, scheduled,
 *      accepted, cancelled, completed, expired). A user never sees the same
 *      partner twice. Backed by the `matches_pair_canonical_idx` functional
 *      index on `LEAST/GREATEST(user_a_id, user_b_id)`.
 *   6. Cooldown: skip users whose `lastMatchedAt` is within MATCH_COOLDOWN_MS.
 *   7. Verification gate: admit only `verified` users plus the explicit legacy
 *      cohort that already has `verificationSkippedAt`. New `unverified`,
 *      `pending`, `pending_review`, and `rejected` users never enter the pool.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MATCH_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_CANDIDATE_LIMIT = 5;

/** Wider pool fetched from SQL before Node.js re-ranking. */
const CANDIDATE_POOL_SIZE = 20;
const ACTIVE_MATCH_STATUS_SQL = ACTIVE_MATCH_STATUSES.map((status) => `'${status}'`).join(", ");

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

export const SCORING_WEIGHTS = {
  /**
   * Semantic embedding similarity (cosine). Lowered 0.80 → 0.65 on 2026-06-21
   * once `V_research` gained a reliable structured vibe signal (quadrant
   * proximity) and the embedding was de-noised by stripping duplicated
   * demographics out of the fallback summary (see `profile-analysis.ts`).
   */
  explicit: 0.65,
  /**
   * Structured compatibility heuristics: vibe quadrant proximity (the "tempo"
   * axis), age gradient, height norm, educational homogamy. Raised 0.20 → 0.35
   * because the bucket is no longer phantom — the keyword-scanned social-energy
   * factor was replaced by the structured `energyAxis`/`orientationAxis` columns.
   */
  research: 0.35,
  /** Negative constraint penalty — subtracted from total. */
  penalty: 0.30,
} as const;

// ---------------------------------------------------------------------------
// Vibe quadrant proximity (V_research sub-factor)
// ---------------------------------------------------------------------------

/**
 * Weight of the energy axis relative to the orientation axis inside the vibe
 * distance. Energy (internal↔external "tempo") is weighted heavier because a
 * large tempo gap is the documented must-have friction point — one partner
 * wants to keep going at 2am, the other is done by 23:00 (PRODUCT_SPEC §3.2).
 */
export const VIBE_ENERGY_WEIGHT = 0.7;
export const VIBE_ORIENTATION_WEIGHT = 0.3;

/** Clamp a raw axis value to the canonical [-1, 1] range. */
function clampAxis(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Vibe quadrant proximity → 0..1 over the two onboarding-derived axes
 * (`energyAxis`, `orientationAxis`). 1 = same point, 0 = opposite corner.
 *
 * This is a *proximity* (similarity) signal, NOT complementarity: two people
 * with a similar tempo land in the same/adjacent quadrant and score high; a big
 * tempo gap (opposite energy) is heavily penalised. Role-complementarity within
 * a shared quadrant (Phase 2) is deliberately NOT scored here yet — `socialRole`
 * is stored but unused until there is accept/decline data to validate it.
 *
 * Returns `null` (factor skipped, weight renormalised away) when either side
 * lacks an energy axis. A missing orientation axis is treated as the neutral
 * midpoint (0) rather than dropping the whole factor.
 */
export function quadrantProximityScore(
  aEnergy: number | null,
  aOrientation: number | null,
  bEnergy: number | null,
  bOrientation: number | null,
): number | null {
  if (aEnergy == null || bEnergy == null) return null;
  const dEnergy = Math.abs(clampAxis(aEnergy) - clampAxis(bEnergy)); // 0..2
  const dOrient = Math.abs(
    clampAxis(aOrientation ?? 0) - clampAxis(bOrientation ?? 0),
  ); // 0..2
  // Weighted Manhattan distance, max = 2 (both axes opposite).
  const dist =
    VIBE_ENERGY_WEIGHT * dEnergy + VIBE_ORIENTATION_WEIGHT * dOrient;
  return Math.max(0, 1 - dist / 2);
}

// ---------------------------------------------------------------------------
// Elo league penalty
// ---------------------------------------------------------------------------

/**
 * Elo gap below which the league multiplier is a no-op.
 *
 * The vision seed maps a 0..100 attractiveness score to Elo 200..800 (6 Elo
 * per attractiveness point), so this tolerance is a free pass of only ~10
 * attractiveness points. Tightened from 150 on 2026-06-06 to make
 * similar-attractiveness the *primary* match gate (assortative matching):
 * a big looks gap now crushes the positive signal, while psychology
 * (embedding/research) still fully ranks pairs inside a tier.
 */
export const LEAGUE_TOLERANCE = 60;
/** Decay slope per Elo point past `LEAGUE_TOLERANCE`. */
export const LEAGUE_DECAY_PER_POINT = 0.005;
/** Floor so an out-of-league candidate keeps a small positive weight. */
export const LEAGUE_FLOOR = 0.05;

/**
 * `V_league`: Elo-distance multiplier applied to (V_explicit + V_research)
 * BEFORE the penalty subtraction. Same league = 1.0, decays linearly past
 * `LEAGUE_TOLERANCE` and clamps at `LEAGUE_FLOOR` so a far-out-of-league pair
 * never goes negative purely from the league factor.
 *
 * With the tightened constants, attractiveness is the dominant ranking
 * factor: a ~10pt gap still gives 1.0, ~20pt → 0.70, ~30pt → 0.40,
 * ~40pt → 0.10, and a "90 vs 30" pairing floors at `LEAGUE_FLOOR` (0.05) —
 * effectively never matched unless the starvation bonus rescues a stuck user.
 *
 * Defaults when either side has no rating yet (e.g. mid-onboarding edge):
 * returns 1.0 — let the embedding decide. The Elo seed lands during the
 * Persona webhook so this only matters in narrow race windows.
 */
export function leagueScore(eloDelta: number): number {
  const delta = Math.abs(eloDelta);
  if (delta <= LEAGUE_TOLERANCE) return 1.0;
  return Math.max(LEAGUE_FLOOR, 1.0 - (delta - LEAGUE_TOLERANCE) * LEAGUE_DECAY_PER_POINT);
}

/**
 * Male upward "reach" allowance, in Elo. For a hetero (M/F) pair, when the
 * woman out-scores the man we discount the gap by this amount before the
 * standard league decay — so a less-attractive man is matched with a somewhat
 * MORE-attractive woman without the league penalty crushing the pair. Matching
 * "down" (man already more attractive) is unaffected, and same-gender /
 * unknown-gender pairs keep the symmetric `leagueScore`.
 *
 * Default 36 Elo ≈ 6 attractiveness points (6 Elo per vision point). Sourced
 * from `MALE_REACH_ELO` env so ops can tune the lift in prod without a code
 * deploy; read directly (not via `config.ts`) to keep this module's pure
 * scoring functions importable in unit tests without env. Clamped ≥ 0 so a
 * negative value can never silently penalise men reaching up.
 *
 * @see PRODUCT_SPEC.md — Phase 3 (Matching Engine), V_league multiplier
 */
export const MALE_REACH_ELO = Math.max(0, Number(process.env.MALE_REACH_ELO ?? "36"));

/**
 * Gender-aware league multiplier for a pair.
 *
 * Hetero pair, woman more attractive → man reaches up: discount the gap by
 * `reachElo` (one-directional). Hetero pair, man more attractive, or any
 * same-gender / unknown-gender pair → symmetric `leagueScore(|delta|)`.
 *
 * The result depends only on the two (elo, gender) tuples, not on which side
 * is "A" vs "B", so `scorePair`'s two directions stay in agreement.
 */
export function pairLeagueScore(
  aElo: number,
  aGender: string | null,
  bElo: number,
  bGender: string | null,
  reachElo: number = MALE_REACH_ELO,
): number {
  const isHetero =
    (aGender === "male" && bGender === "female") ||
    (aGender === "female" && bGender === "male");

  if (!isHetero) return leagueScore(aElo - bElo);

  const maleElo = aGender === "male" ? aElo : bElo;
  const femaleElo = aGender === "female" ? aElo : bElo;
  const womanAdvantage = femaleElo - maleElo; // positive = woman more attractive

  if (womanAdvantage > 0) {
    // Man reaching up — forgive `reachElo` of the gap before the decay.
    return leagueScore(Math.max(0, womanAdvantage - reachElo));
  }
  // Man more attractive or equal — unchanged symmetric penalty.
  return leagueScore(womanAdvantage);
}

// ---------------------------------------------------------------------------
// Stated age-range preference (V_agePref multiplier)
// ---------------------------------------------------------------------------

/**
 * Floor of the age-range preference multiplier. A candidate fully outside the
 * seeker's stated band never drops the positive bracket below this fraction —
 * the band is a *soft* preference, not a hard filter, so an exceptional
 * embedding/league fit can still surface an out-of-band partner (and a thin
 * city pool is never starved). Sourced from `AGE_RANGE_PREF_FLOOR` env so ops
 * can tune it without a deploy; read directly (not via `config.ts`) to keep the
 * scoring functions importable in unit tests without env. Clamped to [0, 1].
 */
export const AGE_RANGE_PREF_FLOOR = Math.min(
  1,
  Math.max(0, Number(process.env.AGE_RANGE_PREF_FLOOR ?? "0.6")),
);
/**
 * Per-year decay of the age-range preference multiplier for each year the
 * candidate's age falls outside the seeker's stated band, until it reaches
 * `AGE_RANGE_PREF_FLOOR`. Default 0.1 → a near-miss (1 yr out) is barely
 * dampened (0.9), a 4+ yr miss floors. Sourced from `AGE_RANGE_PREF_DECAY_PER_YEAR`
 * env; clamped ≥ 0.
 */
export const AGE_RANGE_PREF_DECAY_PER_YEAR = Math.max(
  0,
  Number(process.env.AGE_RANGE_PREF_DECAY_PER_YEAR ?? "0.1"),
);

/**
 * `V_agePref`: how well a candidate's *actual* age satisfies the seeker's
 * stated **preferred-partner age band** (`Profile.ageRangeMin/Max`). Returns a
 * multiplier in `[floor, 1]` applied to the positive bracket alongside
 * `V_league`.
 *
 * - No band set (`min` and `max` both null) → 1.0 (neutral; most users never
 *   set one, so this is the common path and preserves prior behaviour).
 * - Unknown candidate age → 1.0 (no data, don't penalise).
 * - Candidate age inside `[min, max]` (inclusive) → 1.0.
 * - Outside → linear decay `1 - yearsOutside * decayPerYear`, floored at
 *   `floor`. A one-sided band (only `min` or only `max`) is honoured by treating
 *   the missing bound as ±∞.
 *
 * Deliberately distinct from `ageGradientScore` (which scores the *closeness of
 * the two real ages*): this scores whether the candidate falls in the band the
 * seeker explicitly asked for. Both can apply at once.
 */
export function ageRangePreferenceScore(
  rangeMin: number | null,
  rangeMax: number | null,
  candidateAge: number | null,
  floor: number = AGE_RANGE_PREF_FLOOR,
  decayPerYear: number = AGE_RANGE_PREF_DECAY_PER_YEAR,
): number {
  if (rangeMin == null && rangeMax == null) return 1.0;
  if (candidateAge == null) return 1.0;
  const lo = rangeMin ?? -Infinity;
  const hi = rangeMax ?? Infinity;
  if (candidateAge >= lo && candidateAge <= hi) return 1.0;
  const yearsOutside =
    candidateAge < lo ? lo - candidateAge : candidateAge - hi;
  return Math.max(floor, 1.0 - yearsOutside * decayPerYear);
}

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
 * `standbyCount` consecutive batches. Linearly scaled by `STARVATION_ALPHA`,
 * capped at `STARVATION_CAP`. Non-starved users (0 or negative) return 0.
 */
export function starvationBonus(standbyCount: number): number {
  if (standbyCount <= 0) return 0;
  return Math.min(STARVATION_CAP, STARVATION_ALPHA * standbyCount);
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
  energyAxis: number | null;
  orientationAxis: number | null;
  eloScore: number;
  homeCityKey: string | null;
}

/** Seeker profile data needed for scoring. */
export interface SeekerProfile {
  age: number | null;
  gender: string | null;
  height: number | null;
  major: string | null;
  negativeConstraints: string | null;
  energyAxis: number | null;
  orientationAxis: number | null;
  eloScore: number;
  /** Stated preferred-partner age band (`Profile.ageRangeMin/Max`); null when
   *  the user never set one. Drives the `V_agePref` multiplier. */
  ageRangeMin: number | null;
  ageRangeMax: number | null;
}

export interface ScoredCandidate {
  userId: string;
  telegramId: bigint;
  firstName: string | null;
  score: number;
  breakdown: {
    explicit: number;
    research: number;
    league: number;
    penalty: number;
    /** Stated age-range preference multiplier (`V_agePref`), 1 = neutral. */
    agePref: number;
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
      p.energy_axis           AS "energyAxis",
      p.orientation_axis      AS "orientationAxis",
      p.elo_score             AS "eloScore",
      p.home_city_key         AS "homeCityKey",
      (p.embedding <=> $2::vector) AS distance
    FROM users u
    JOIN profiles p ON p.user_id = u.id
    WHERE u.id <> $1::uuid
      AND u.status = 'active'
      AND u.onboarding_step = 'completed'
      AND (
        u.verification_status = 'verified'
        OR (
          u.verification_status = 'unverified'
          AND u.verification_skipped_at IS NOT NULL
        )
      )
      AND (u.is_email_verified OR u.phone_verified_at IS NOT NULL)
      AND p.home_city_key = $3
      AND p.latitude IS NOT NULL
      AND p.longitude IS NOT NULL
      AND p.embedding IS NOT NULL
      AND ($5 = '' OR u.gender::text = $5)
      AND (u.preference::text = 'both' OR u.preference::text = (
        CASE $4 WHEN 'male' THEN 'men' WHEN 'female' THEN 'women' ELSE '' END
      ))
      AND (p.last_matched_at IS NULL OR p.last_matched_at < $6)
      AND NOT EXISTS (
        SELECT 1 FROM matches active_match
         WHERE active_match.status IN (${ACTIVE_MATCH_STATUS_SQL})
           AND (active_match.user_a_id = u.id OR active_match.user_b_id = u.id)
      )
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

/** Escape user-supplied text for safe inclusion in a RegExp source. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a single trait against the candidate summary using Unicode-aware
 * word boundaries. Plain `String.includes` was a footgun: `"smoker"` matched
 * `"non-smoker"`, penalising the perfect candidate. `\b` is ASCII-only so it
 * misfires on Cyrillic; we use `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` instead
 * to honour ru/uk/en bilingual summaries.
 */
function traitHits(summary: string, trait: string): boolean {
  if (!trait) return false;
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegex(trait)}(?![\\p{L}\\p{N}])`,
    "iu",
  );
  return re.test(summary);
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

  let hits = 0;
  for (const trait of traits) {
    if (traitHits(candidateSummary, trait)) {
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
 * Relative weights of the V_research sub-factors. The vibe quadrant carries the
 * most weight because it is the highest-signal compatibility axis; the
 * demographic factors share the rest. Weights only matter relative to each
 * other — missing factors are dropped and the remainder is renormalised.
 */
export const RESEARCH_SUBWEIGHTS = {
  quadrant: 0.40,
  age: 0.20,
  height: 0.20,
  major: 0.20,
} as const;

/**
 * V_research: structured compatibility modifiers. Returns 0..1.
 *
 * Sub-factors (weighted by `RESEARCH_SUBWEIGHTS`, renormalised over whichever
 * are present):
 *   1. Vibe quadrant proximity: similar tempo/orientation → high (PRIMARY).
 *   2. Age gradient: bonus for same-age / male 1–2yr older; penalty > 3yr gap.
 *   3. Height norm: bonus if male is 5–12 cm taller; penalty if shorter.
 *   4. Educational homogamy: same major / same cluster bonus.
 *
 * The old keyword-scanned "social energy" factor is gone — its signal now comes
 * from the structured `energyAxis` inside the quadrant factor, scored once.
 */
export function researchScore(
  seeker: { age: number | null; gender: string | null; height: number | null; energyAxis: number | null; orientationAxis: number | null; major?: string | null },
  candidate: { age: number | null; gender: string | null; height: number | null; energyAxis: number | null; orientationAxis: number | null; major?: string | null },
): number {
  let weighted = 0;
  let weightSum = 0;

  // 1. Vibe quadrant proximity (PRIMARY). Skipped when axes are missing.
  const quadrant = quadrantProximityScore(
    seeker.energyAxis,
    seeker.orientationAxis,
    candidate.energyAxis,
    candidate.orientationAxis,
  );
  if (quadrant != null) {
    weighted += RESEARCH_SUBWEIGHTS.quadrant * quadrant;
    weightSum += RESEARCH_SUBWEIGHTS.quadrant;
  }

  // 2. Age gradient
  if (seeker.age != null && candidate.age != null) {
    weighted +=
      RESEARCH_SUBWEIGHTS.age *
      ageGradientScore(seeker.age, candidate.age, seeker.gender, candidate.gender);
    weightSum += RESEARCH_SUBWEIGHTS.age;
  }

  // 3. Height norm
  if (seeker.height != null && candidate.height != null) {
    let height: number;
    if (seeker.gender === "female" && candidate.gender === "male") {
      height = heightNormScore(candidate.height, seeker.height);
    } else if (seeker.gender === "male" && candidate.gender === "female") {
      height = heightNormScore(seeker.height, candidate.height);
    } else {
      height = 0.5; // Same gender — height is neutral
    }
    weighted += RESEARCH_SUBWEIGHTS.height * height;
    weightSum += RESEARCH_SUBWEIGHTS.height;
  }

  // 4. Educational homogamy
  if (seeker.major || candidate.major) {
    weighted +=
      RESEARCH_SUBWEIGHTS.major *
      majorSimilarityScore(seeker.major ?? null, candidate.major ?? null);
    weightSum += RESEARCH_SUBWEIGHTS.major;
  }

  if (weightSum === 0) return 0.5; // Neutral when no data available
  return weighted / weightSum;
}

// ---------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------

/**
 * Compute the full multi-factor match score for a single candidate.
 * All sub-scores are 0..1; the composite score can go negative if
 * penalty is high enough (such candidates are ranked last).
 *
 * Formula: ((w_explicit * V_explicit) + (w_research * V_research)) * V_league
 *          - (w_penalty * V_penalty)
 */
export function scoreCandidate(
  seeker: SeekerProfile,
  candidate: RichCandidateRow,
  weights = SCORING_WEIGHTS,
): ScoredCandidate {
  const vExplicit = explicitScore(candidate.distance);
  const vResearch = researchScore(
    {
      age: seeker.age,
      gender: seeker.gender,
      height: seeker.height,
      energyAxis: seeker.energyAxis,
      orientationAxis: seeker.orientationAxis,
      major: seeker.major,
    },
    {
      age: candidate.age,
      gender: candidate.gender,
      height: candidate.height,
      energyAxis: candidate.energyAxis,
      orientationAxis: candidate.orientationAxis,
      major: candidate.major,
    },
  );
  const vLeague = pairLeagueScore(
    seeker.eloScore,
    seeker.gender,
    candidate.eloScore,
    candidate.gender,
  );
  const vPenalty = penaltyScore(
    seeker.negativeConstraints,
    candidate.psychologicalSummary,
  );
  const vAgePref = ageRangePreferenceScore(
    seeker.ageRangeMin,
    seeker.ageRangeMax,
    candidate.age,
  );

  const positive =
    (weights.explicit * vExplicit + weights.research * vResearch) *
    vLeague *
    vAgePref;
  const score = positive - weights.penalty * vPenalty;

  return {
    userId: candidate.userId,
    telegramId: candidate.telegramId,
    firstName: candidate.firstName,
    score,
    breakdown: {
      explicit: vExplicit,
      research: vResearch,
      league: vLeague,
      penalty: vPenalty,
      agePref: vAgePref,
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
      isEmailVerified: true,
      phoneVerifiedAt: true,
      verificationStatus: true,
      verificationSkippedAt: true,
      status: true,
      onboardingStep: true,
      profile: {
        select: {
          height: true,
          negativeConstraints: true,
          energyAxis: true,
          orientationAxis: true,
          eloScore: true,
          homeCityKey: true,
          latitude: true,
          longitude: true,
          ageRangeMin: true,
          ageRangeMax: true,
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
    !(
      seeker.verificationStatus === "verified" ||
      (seeker.verificationStatus === "unverified" && seeker.verificationSkippedAt !== null)
    ) ||
    // Registration v2 union contact rail: verified email OR verified phone.
    (!seeker.isEmailVerified && !seeker.phoneVerifiedAt) ||
    !seeker.profile?.homeCityKey ||
    seeker.profile.latitude === null ||
    seeker.profile.longitude === null
  ) {
    return [];
  }

  const seekerHasActiveMatch = await prisma.match.findFirst({
    where: {
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [{ userAId: seekerUserId }, { userBId: seekerUserId }],
    },
    select: { id: true },
  });
  if (seekerHasActiveMatch) return [];

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
    seeker.profile.homeCityKey,
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
    energyAxis: seeker.profile?.energyAxis ?? null,
    orientationAxis: seeker.profile?.orientationAxis ?? null,
    eloScore: seeker.profile?.eloScore ?? 500,
    ageRangeMin: seeker.profile?.ageRangeMin ?? null,
    ageRangeMax: seeker.profile?.ageRangeMax ?? null,
  };

  return rankCandidates(seekerProfile, pool, limit);
}

// ---------------------------------------------------------------------------
// Match creation
// ---------------------------------------------------------------------------

/**
 * Create a `Match` row for the given pair in `proposed` state, and bump
 * `lastMatchedAt` on both profiles so the cooldown takes effect.
 *
 * `breakdown` (optional) freezes the four score components into
 * `MatchScoreLog` so the admin dashboard can A/B test scoring weights
 * against the eventual accept/decline outcome. Callers without scoring
 * context (tests, manual seeding) may omit it.
 */
export async function createProposedMatch(
  userAId: string,
  userBId: string,
  breakdown?: ScoredPair["breakdown"],
): Promise<{ id: string } | null> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Serialize allocations that touch either participant. A sorted lock order
    // avoids deadlocks; the active-match re-check closes the gap between the
    // weekly preview and creation, including overlapping cron executions.
    const participantIds = [userAId, userBId].sort();
    await tx.$queryRawUnsafe(
      "SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      participantIds,
    );
    const existingConflict = await tx.match.findFirst({
      where: {
        OR: [
          {
            status: { in: [...ACTIVE_MATCH_STATUSES] },
            OR: [
              { userAId: { in: participantIds } },
              { userBId: { in: participantIds } },
            ],
          },
          // Lifetime pair ban must survive a stale plan too, even if a prior
          // proposal resolved before this allocation acquired the user locks.
          { userAId, userBId },
          { userAId: userBId, userBId: userAId },
        ],
      },
      select: { id: true },
    });
    if (existingConflict) return null;

    const match = await tx.match.create({
      data: { userAId, userBId, status: "proposed" },
      select: { id: true },
    });
    await tx.profile.updateMany({
      where: { userId: { in: [userAId, userBId] } },
      data: { lastMatchedAt: now },
    });
    if (breakdown) {
      const scoreTotal =
        (SCORING_WEIGHTS.explicit * breakdown.explicit +
          SCORING_WEIGHTS.research * breakdown.research) *
          breakdown.league *
          breakdown.agePref -
        SCORING_WEIGHTS.penalty * breakdown.penalty +
        breakdown.starvationBonus;
      await tx.matchScoreLog.create({
        data: {
          matchId: match.id,
          scoreExplicit: breakdown.explicit,
          scoreResearch: breakdown.research,
          scoreLeague: breakdown.league,
          scorePenalty: breakdown.penalty,
          scoreAgePref: breakdown.agePref,
          scoreTotal,
          embeddingDistance: breakdown.embeddingDistance,
          starvationBonus: breakdown.starvationBonus,
        },
      });
    }
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
   *  `Profile.standbyCount` was just incremented. Consumed by the standby UX. */
  missedUserIds: string[];
}

export interface WeeklyBatchPlan {
  eligible: number;
  pairs: number;
  finalPairs: ScoredPair[];
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
  psychologicalSummary: string | null;
  energyAxis: number | null;
  orientationAxis: number | null;
  embeddingLiteral: string | null;
  eloScore: number;
  /** Consecutive batches this user has been eligible but unpaired. */
  standbyCount: number;
  /** Canonical dating city key used as the hard local matching boundary. */
  homeCityKey: string | null;
  /** Stated preferred-partner age band (`Profile.ageRangeMin/Max`); null when
   *  unset. Feeds the `V_agePref` multiplier in both scoring directions. */
  ageRangeMin: number | null;
  ageRangeMax: number | null;
}

/** A scored pair produced by the global scoring phase. */
export interface ScoredPair {
  userAId: string;
  userBId: string;
  score: number;
  /// Score components averaged across both directions, kept so that
  /// `MatchScoreLog` can be persisted at match creation. Optional because
  /// historical callers / tests may not need it.
  breakdown?: {
    explicit: number;
    research: number;
    league: number;
    penalty: number;
    agePref: number;
    embeddingDistance: number;
    starvationBonus: number;
  };
}

/**
 * Check mutual gender compatibility between two users.
 * a's preference must include b's gender AND b's preference must include a's gender.
 */
export function areMutuallyCompatible(a: BatchUser, b: BatchUser): boolean {
  if (!a.gender || !b.gender || !a.preference || !b.preference) return false;
  if (!a.homeCityKey || !b.homeCityKey || a.homeCityKey !== b.homeCityKey) return false;

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
 * Score a pair of BatchUsers using the multi-factor formula.
 * Requires the embedding distance to be pre-computed via SQL.
 *
 * The Elo league multiplier is symmetric (|delta|), so the two directions
 * agree on `V_league` even though `V_penalty` and `V_research` may differ
 * by direction.
 */
export interface PairScoreResult {
  score: number;
  breakdown: {
    explicit: number;
    research: number;
    league: number;
    penalty: number;
    agePref: number;
    embeddingDistance: number;
    starvationBonus: number;
  };
}

export function scorePair(
  a: BatchUser,
  b: BatchUser,
  embeddingDistance: number,
): PairScoreResult {
  const seekerA: SeekerProfile = {
    age: a.age,
    gender: a.gender,
    height: a.height,
    major: a.major,
    negativeConstraints: a.negativeConstraints,
    energyAxis: a.energyAxis,
    orientationAxis: a.orientationAxis,
    eloScore: a.eloScore,
    ageRangeMin: a.ageRangeMin,
    ageRangeMax: a.ageRangeMax,
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
    energyAxis: b.energyAxis,
    orientationAxis: b.orientationAxis,
    eloScore: b.eloScore,
    homeCityKey: b.homeCityKey,
  };

  const scored = scoreCandidate(seekerA, candidateB);

  // Average with the reverse direction so the score is symmetric.
  const seekerB: SeekerProfile = {
    age: b.age,
    gender: b.gender,
    height: b.height,
    major: b.major,
    negativeConstraints: b.negativeConstraints,
    energyAxis: b.energyAxis,
    orientationAxis: b.orientationAxis,
    eloScore: b.eloScore,
    ageRangeMin: b.ageRangeMin,
    ageRangeMax: b.ageRangeMax,
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
    energyAxis: a.energyAxis,
    orientationAxis: a.orientationAxis,
    eloScore: a.eloScore,
    homeCityKey: a.homeCityKey,
  };

  const scoredReverse = scoreCandidate(seekerB, candidateA);

  const base = (scored.score + scoredReverse.score) / 2;
  // Starvation priority: boost the pair by the MAX of each side's bonus,
  // never the sum — two starved users shouldn't stack priority and pair
  // off with each other at the expense of fresh users.
  const bonus = Math.max(starvationBonus(a.standbyCount), starvationBonus(b.standbyCount));
  return {
    score: base + bonus,
    breakdown: {
      explicit: (scored.breakdown.explicit + scoredReverse.breakdown.explicit) / 2,
      research: (scored.breakdown.research + scoredReverse.breakdown.research) / 2,
      league: (scored.breakdown.league + scoredReverse.breakdown.league) / 2,
      penalty: (scored.breakdown.penalty + scoredReverse.breakdown.penalty) / 2,
      agePref: (scored.breakdown.agePref + scoredReverse.breakdown.agePref) / 2,
      embeddingDistance,
      starvationBonus: bonus,
    },
  };
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
      AND: [
        // Registration v2 union contact rail: verified email OR verified phone.
        { OR: [{ isEmailVerified: true }, { phoneVerifiedAt: { not: null } }] },
        // Mandatory identity gate with an explicit persisted legacy cohort.
        {
          OR: [
            { verificationStatus: "verified" },
            { verificationStatus: "unverified", verificationSkippedAt: { not: null } },
          ],
        },
      ],
      profile: {
        lastMatchedAt: { lt: cutoff },
        homeCityKey: { not: null },
        latitude: { not: null },
        longitude: { not: null },
      },
      matchesAsA: { none: { status: { in: [...ACTIVE_MATCH_STATUSES] } } },
      matchesAsB: { none: { status: { in: [...ACTIVE_MATCH_STATUSES] } } },
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
          psychologicalSummary: true,
          energyAxis: true,
          orientationAxis: true,
          eloScore: true,
          standbyCount: true,
          homeCityKey: true,
          ageRangeMin: true,
          ageRangeMax: true,
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
      AND: [
        { OR: [{ isEmailVerified: true }, { phoneVerifiedAt: { not: null } }] },
        {
          OR: [
            { verificationStatus: "verified" },
            { verificationStatus: "unverified", verificationSkippedAt: { not: null } },
          ],
        },
      ],
      profile: {
        lastMatchedAt: null,
        homeCityKey: { not: null },
        latitude: { not: null },
        longitude: { not: null },
      },
      matchesAsA: { none: { status: { in: [...ACTIVE_MATCH_STATUSES] } } },
      matchesAsB: { none: { status: { in: [...ACTIVE_MATCH_STATUSES] } } },
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
          psychologicalSummary: true,
          energyAxis: true,
          orientationAxis: true,
          eloScore: true,
          standbyCount: true,
          homeCityKey: true,
          ageRangeMin: true,
          ageRangeMax: true,
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
      psychologicalSummary: u.profile?.psychologicalSummary ?? null,
      energyAxis: u.profile?.energyAxis ?? null,
      orientationAxis: u.profile?.orientationAxis ?? null,
      embeddingLiteral: embeddingMap.get(u.id) ?? null,
      eloScore: u.profile?.eloScore ?? 500,
      standbyCount: u.profile?.standbyCount ?? 0,
      homeCityKey: u.profile?.homeCityKey ?? null,
      ageRangeMin: u.profile?.ageRangeMin ?? null,
      ageRangeMax: u.profile?.ageRangeMax ?? null,
    }));
}

/**
 * Strict UUID v1-5 regex used to gate any id that's spliced into raw SQL.
 * The DB column is `@db.Uuid` so values fetched from Prisma are guaranteed
 * to match this shape — we still validate as defense-in-depth so a future
 * caller that hands in user-supplied text can't trigger SQL injection
 * through the `UNION ALL` pair builder.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Exported for tests. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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
      // Defense-in-depth: refuse to splice anything that doesn't match the
      // UUID shape into the SQL string. The `users` table column is `@db.Uuid`
      // so this should never trigger in practice, but a future regression
      // (e.g. someone calling this fn with stub data from a test or the
      // mobile API) won't open a SQL-injection hole.
      if (!isUuid(a.id) || !isUuid(b.id)) {
        console.warn(
          `[match-engine] computePairwiseDistances: refusing non-UUID id (a=${a.id}, b=${b.id})`,
        );
        continue;
      }
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
  const plan = await previewWeeklyBatch();
  if (plan.eligible === 0) {
    return { eligible: 0, pairs: 0, matchIds: [], missedUserIds: [] };
  }

  // Create match rows.
  const matchIds: string[] = [];
  const createdPairs: ScoredPair[] = [];
  const skippedUserIds: string[] = [];
  for (const pair of plan.finalPairs) {
    const match = await createProposedMatch(
      pair.userAId,
      pair.userBId,
      pair.breakdown,
    );
    if (match) {
      matchIds.push(match.id);
      createdPairs.push(pair);
    } else {
      skippedUserIds.push(pair.userAId, pair.userBId);
    }
  }

  // Diff eligible-vs-paired and update starvation counters.
  const pairedUserIds = createdPairs.flatMap((pair) => [pair.userAId, pair.userBId]);
  const missedCandidates = [...new Set([...plan.missedUserIds, ...skippedUserIds])];
  const activeRows =
    missedCandidates.length === 0
      ? []
      : await prisma.match.findMany({
          where: {
            status: { in: [...ACTIVE_MATCH_STATUSES] },
            OR: [
              { userAId: { in: missedCandidates } },
              { userBId: { in: missedCandidates } },
            ],
          },
          select: { userAId: true, userBId: true },
        });
  const activeUserIds = new Set(
    activeRows.flatMap((match) => [match.userAId, match.userBId]),
  );
  const missedUserIds = missedCandidates.filter((userId) => !activeUserIds.has(userId));
  const now = new Date();

  await prisma.$transaction([
    prisma.profile.updateMany({
      where: { userId: { in: pairedUserIds } },
      data: { standbyCount: 0, missedWeeks: 0 },
    }),
    prisma.profile.updateMany({
      where: { userId: { in: missedUserIds } },
      data: {
        standbyCount: { increment: 1 },
        missedWeeks: { increment: 1 },
        lastMissedAt: now,
      },
    }),
  ]);

  console.log(
    `[weekly-batch] eligible=${plan.eligible} pairs=${matchIds.length} missed=${missedUserIds.length}`,
  );

  return {
    eligible: plan.eligible,
    pairs: matchIds.length,
    matchIds,
    missedUserIds,
  };
}

export async function previewWeeklyBatch(): Promise<WeeklyBatchPlan> {
  const users = await loadEligibleUsers();
  if (users.length === 0) {
    return { eligible: 0, pairs: 0, finalPairs: [], missedUserIds: [] };
  }
  if (users.length === 1) {
    return {
      eligible: 1,
      pairs: 0,
      finalPairs: [],
      missedUserIds: [users[0]!.id],
    };
  }

  const userIds = users.map((u) => u.id);
  const historicalPairs = await loadHistoricalMatchPairs(userIds);

  const userMap = new Map<string, BatchUser>();
  for (const u of users) {
    userMap.set(u.id, u);
  }

  const distances = await computePairwiseDistances(users);

  const scoredPairs: ScoredPair[] = [];
  for (const [key, distance] of distances) {
    const [aId, bId] = key.split(":");
    if (!aId || !bId) continue;
    if (historicalPairs.has(`${aId}:${bId}`)) continue;

    const a = userMap.get(aId);
    const b = userMap.get(bId);
    if (!a || !b) continue;

    const { score, breakdown } = scorePair(a, b, distance);
    scoredPairs.push({ userAId: aId, userBId: bId, score, breakdown });
  }

  const finalPairs = greedyPair(scoredPairs);
  const pairedIds = new Set<string>();
  for (const pair of finalPairs) {
    pairedIds.add(pair.userAId);
    pairedIds.add(pair.userBId);
  }

  return {
    eligible: users.length,
    pairs: finalPairs.length,
    finalPairs,
    missedUserIds: users.filter((u) => !pairedIds.has(u.id)).map((u) => u.id),
  };
}
