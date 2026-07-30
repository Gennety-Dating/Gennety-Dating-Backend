/**
 * Venue diversity (PRODUCT_SPEC §3.7, VENUE_ENGINE_IMPROVEMENT_PLAN stage 3).
 *
 * The ranker answers "which venue fits this pair best". It is deterministic, so
 * with a stable catalog it answers the same thing for every pair in the city —
 * which is how one venue ended up carrying most of the dates while hundreds of
 * good ones never got proposed once.
 *
 * This module is the layer that decides between venues the ranker considers
 * near-equal. The ordering is deliberate and load-bearing (founder requirement
 * T4 — variety must never cost quality):
 *
 *   1. personal history  — HARD exclusion. Being sent to a venue you already
 *      had a date at is bad regardless of how well it scores.
 *   2. slot cap          — HARD exclusion. Two of our own pairs at the same
 *      venue in the same hours is a privacy problem, not just a dull one.
 *   3. fatigue + explore — SOFT multipliers, deliberately weak. A great venue
 *      used a few times still beats a mediocre unused one.
 *   4. sampling          — only among candidates within `samplingBand` of the
 *      best remaining score, and only when that best clears the vibe floor.
 *      A clear winner is always taken as-is.
 *
 * Everything here is pure except `loadVenueUsage`, so the policy is testable
 * without a database.
 */

import { prisma } from "@gennety/db";

/** A venue the caller already scored. `id` is the ranker's stable place key. */
export interface DiversityCandidate {
  id: string;
  score: number;
  /** Pair fit from the score breakdown — gates the diversity mechanics. */
  pairFit: number;
}

export interface VenueUsage {
  /** Place keys either participant has already had a date at. */
  personal: Set<string>;
  /** Place key → decayed count of recent assignments across all pairs. */
  fatigue: Map<string, number>;
  /** Place key → how many pairs are already booked in the same slot window. */
  sameSlot: Map<string, number>;
  /** Place keys that have never been assigned in the lookback window. */
  everUsed: Set<string>;
}

export interface DiversityOptions {
  /**
   * Weight of the fatigue penalty: score is multiplied by `1 / (1 + k * N)`.
   * Deliberately small — at the default a venue assigned three times recently
   * keeps ~81% of its score, so it still beats a clearly worse alternative.
   */
  fatigueWeight: number;
  /** Additive bonus for a venue never assigned in the window. */
  explorationBonus: number;
  /** Max pairs allowed at one venue inside the same slot window. */
  slotCap: number;
  /** Relative band below the top score that competes in the sampling draw. */
  samplingBand: number;
  /**
   * Minimum pair fit for the diversity mechanics to engage at all. Below this
   * the pool is poor enough that the best available option is simply taken —
   * shuffling among bad fits would trade quality for nothing.
   */
  minPairFit: number;
}

export const DEFAULT_DIVERSITY_OPTIONS: DiversityOptions = {
  fatigueWeight: 0.08,
  explorationBonus: 0.03,
  slotCap: 1,
  samplingBand: 0.05,
  minPairFit: 0.25,
};

/** How far back a personal repeat still counts. */
export const VENUE_HISTORY_DAYS = 180;
/** Lookback for the global fatigue signal. */
export const VENUE_FATIGUE_WINDOW_DAYS = 30;
/** Half-width of the "same evening at the same place" window. */
export const VENUE_SLOT_WINDOW_HOURS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Recency-weighted assignment count: today counts fully, this week most of the
 * way, the rest of the month a little. A venue that was busy last month should
 * not be held against itself forever.
 */
export function fatigueWeightForAge(ageMs: number): number {
  if (ageMs < 0) return 1;
  if (ageMs <= DAY_MS) return 1;
  if (ageMs <= 7 * DAY_MS) return 0.6;
  if (ageMs <= VENUE_FATIGUE_WINDOW_DAYS * DAY_MS) return 0.25;
  return 0;
}

/**
 * Read every diversity signal in one pass over `matches`. Deliberately no new
 * table: the assignment history already lives on the match rows, so a counter
 * would be a second source of truth that can drift.
 */
export async function loadVenueUsage(input: {
  userAId: string;
  userBId: string;
  agreedTime: Date;
  now?: Date;
}): Promise<VenueUsage> {
  const now = input.now ?? new Date();
  const historySince = new Date(now.getTime() - VENUE_HISTORY_DAYS * DAY_MS);
  const slotFrom = new Date(input.agreedTime.getTime() - VENUE_SLOT_WINDOW_HOURS * 60 * 60 * 1000);
  const slotTo = new Date(input.agreedTime.getTime() + VENUE_SLOT_WINDOW_HOURS * 60 * 60 * 1000);

  const rows = await prisma.match.findMany({
    where: {
      venuePlaceId: { not: null },
      agreedTime: { not: null, gte: historySince },
    },
    select: { venuePlaceId: true, agreedTime: true, userAId: true, userBId: true },
  });

  const personal = new Set<string>();
  const fatigue = new Map<string, number>();
  const sameSlot = new Map<string, number>();
  const everUsed = new Set<string>();
  const participants = new Set([input.userAId, input.userBId]);

  for (const row of rows) {
    const key = row.venuePlaceId;
    const when = row.agreedTime;
    if (!key || !when) continue;
    everUsed.add(key);

    if (participants.has(row.userAId) || participants.has(row.userBId)) {
      personal.add(key);
    }
    const weight = fatigueWeightForAge(now.getTime() - when.getTime());
    if (weight > 0) fatigue.set(key, (fatigue.get(key) ?? 0) + weight);
    if (when >= slotFrom && when <= slotTo) {
      sameSlot.set(key, (sameSlot.get(key) ?? 0) + 1);
    }
  }

  return { personal, fatigue, sameSlot, everUsed };
}

/** FNV-1a → 32-bit seed. Mirrors the venue-change board's stable shuffle. */
function hashSeed(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — deterministic draw so a re-run picks the same venue. */
function seededUnit(seed: string): number {
  let a = hashSeed(seed);
  a = (a + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export interface DiversityDecision<T extends DiversityCandidate> {
  chosen: T | null;
  /** Why the pick happened — logged, and the reason a test can assert on. */
  reason: "argmax-below-floor" | "argmax-single" | "sampled" | "empty";
  /** Candidates that survived the hard exclusions, rescored, best first. */
  pool: T[];
}

/**
 * Apply the diversity policy to an already-ranked candidate list.
 *
 * `ranked` must be sorted best-first by the caller; `seed` should be the match
 * id so the same match always resolves to the same venue on a retry.
 */
export function applyVenueDiversity<T extends DiversityCandidate>(
  ranked: readonly T[],
  usage: VenueUsage,
  seed: string,
  options: DiversityOptions = DEFAULT_DIVERSITY_OPTIONS,
): DiversityDecision<T> {
  if (ranked.length === 0) return { chosen: null, reason: "empty", pool: [] };

  // 1-2. Hard exclusions. Fall back to the unfiltered list rather than
  // returning nothing: a repeat venue beats failing to schedule the date.
  const hardFiltered = ranked.filter(
    (row) => !usage.personal.has(row.id) && (usage.sameSlot.get(row.id) ?? 0) < options.slotCap,
  );
  const survivors = hardFiltered.length > 0 ? hardFiltered : [...ranked];

  // 3. Soft rescoring.
  const rescored = survivors
    .map((row) => {
      const n = usage.fatigue.get(row.id) ?? 0;
      const fatigued = row.score / (1 + options.fatigueWeight * n);
      const explore =
        !usage.everUsed.has(row.id) && row.pairFit >= options.minPairFit
          ? options.explorationBonus
          : 0;
      return { row, score: fatigued + explore };
    })
    .sort((left, right) => right.score - left.score);

  const top = rescored[0]!;

  // 4. Sampling — only when the winner is a genuinely good fit, and only among
  // candidates the ranker considers near-equal to it.
  if (top.row.pairFit < options.minPairFit) {
    return { chosen: top.row, reason: "argmax-below-floor", pool: rescored.map((r) => r.row) };
  }
  // The floor excludes a candidate from the draw as well, not just from the
  // exploration bonus: otherwise a poor-fit venue sitting a hair below a good
  // one could still win the sampling and quality would leak away exactly where
  // the floor exists to protect it.
  const cutoff = top.score * (1 - options.samplingBand);
  const band = rescored.filter((row) => row.score >= cutoff && row.row.pairFit >= options.minPairFit);
  if (band.length <= 1) {
    return { chosen: top.row, reason: "argmax-single", pool: rescored.map((r) => r.row) };
  }

  // Weight by score inside the band. They are near-ties by construction, so
  // this stays close to uniform while never preferring the weaker one.
  const total = band.reduce((sum, row) => sum + row.score, 0);
  let ticket = seededUnit(seed) * total;
  for (const row of band) {
    ticket -= row.score;
    if (ticket <= 0) {
      return { chosen: row.row, reason: "sampled", pool: rescored.map((r) => r.row) };
    }
  }
  return { chosen: band[band.length - 1]!.row, reason: "sampled", pool: rescored.map((r) => r.row) };
}
