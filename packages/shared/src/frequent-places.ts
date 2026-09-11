/**
 * Frequently visited places — the catalog venues a person keeps coming back
 * to, shown on their own profile and to their current match
 * (docs/product/domains/frequent-places.md).
 *
 * Every number the feature runs on lives here, so the server and the client it
 * hands them to (the fences payload carries the client's half) read one
 * definition. Nothing here talks to a provider: a position is only ever
 * compared against our own catalog, so the feature has no per-call cost at all.
 */

/**
 * The catalog categories the feature recognises.
 *
 * Only categories the catalog actually holds. The founder's brief also named
 * gyms (> 6 visits), supermarkets (> 6), niche boutiques (2–3) and cinemas
 * (2–3); the catalog carries none of them, and filling it is paid Places
 * seeding — a separate decision (decision journal, 2026-09-11). A rule for a
 * category no row can have would be configuration that can never run.
 *
 * `park` is deliberately absent: a park is an area rather than a venue, so a
 * point-and-radius test cannot tell sitting in it from walking through it, and
 * a park someone crosses every day is a proxy for where they live.
 */
export const FREQUENT_PLACE_CATEGORIES = [
  "cafe",
  "coffee_shop",
  "restaurant",
  "lounge",
  "museum",
] as const;

export type FrequentPlaceCategory = (typeof FREQUENT_PLACE_CATEGORIES)[number];

export function isFrequentPlaceCategory(value: string): value is FrequentPlaceCategory {
  return (FREQUENT_PLACE_CATEGORIES as readonly string[]).includes(value);
}

/** How one category is detected and ranked. */
export interface FrequentPlaceRule {
  /** A fix must fall this close to the catalog point, in metres. */
  radiusM: number;
  /** Distinct days with a visit, inside the window, before the place counts. */
  minVisits: number;
  /**
   * How much a place of this category says about a person at equal
   * normalised frequency. The less routine the category, the more it weighs.
   */
  weight: number;
  /**
   * The longest silence between two fixes that still reads as one stay. A
   * museum visit runs hours with the phone in a pocket; a coffee does not.
   */
  maxGapMinutes: number;
}

/**
 * The per-category table. Thresholds are the founder's brief read as "more
 * than N" (cafés and restaurants: > 4, so 5) and "2–3" taken at its safe end
 * (a museum twice can be one exhibition and its sequel). The radii sit inside
 * the brief's 30–50 m: a café is a shopfront, a museum a building.
 */
export const FREQUENT_PLACE_RULES: Readonly<Record<FrequentPlaceCategory, FrequentPlaceRule>> = {
  cafe: { radiusM: 35, minVisits: 5, weight: 1, maxGapMinutes: 90 },
  coffee_shop: { radiusM: 35, minVisits: 5, weight: 1, maxGapMinutes: 90 },
  restaurant: { radiusM: 40, minVisits: 5, weight: 1, maxGapMinutes: 120 },
  lounge: { radiusM: 40, minVisits: 5, weight: 1, maxGapMinutes: 180 },
  museum: { radiusM: 50, minVisits: 3, weight: 1.3, maxGapMinutes: 180 },
};

/** A stay shorter than this is walking past, whatever the radius says. */
export const FREQUENT_PLACE_MIN_DWELL_MINUTES = 15;

/**
 * A fix vaguer than this (iOS `horizontalAccuracy`, metres) is not evidence of
 * anything: at 50 m the circle already covers the shopfronts either side.
 */
export const FREQUENT_PLACE_MAX_ACCURACY_M = 50;

/**
 * When the second-nearest catalog place is within this many metres of the
 * nearest, one fix cannot tell them apart and counts for neither. This is what
 * a mall or a street of cafés costs: no visit from a position there, only from
 * a date the person actually attended.
 */
export const FREQUENT_PLACE_AMBIGUITY_MARGIN_M = 15;

/**
 * A fix older than this when it is sent says where someone WAS. The client
 * reports the age it measured on its own clock, so device clock skew cannot
 * turn a stale fix into a fresh one or a fresh one into a stale one.
 */
export const FREQUENT_PLACE_FIX_MAX_AGE_SECONDS = 60;

/** How often an app that stays open takes one more fix. */
export const FREQUENT_PLACE_PROBE_INTERVAL_SECONDS = 600;

/** Visits older than this neither count toward a threshold nor stay stored. */
export const FREQUENT_PLACE_WINDOW_DAYS = 180;

/** A visit this many days old weighs half as much in the ranking. */
export const FREQUENT_PLACE_HALF_LIFE_DAYS = 45;

/** Places shown on the profile and to the match. */
export const FREQUENT_PLACE_PROFILE_LIMIT = 3;

/** At most this many of the shown places may share a category. */
export const FREQUENT_PLACE_PER_CATEGORY_LIMIT = 2;
