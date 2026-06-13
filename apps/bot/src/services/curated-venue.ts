/**
 * Curated venue resolver (Phase 3.7 — concierge venue flow).
 *
 * The product is hyper-local: both matched users always share the same
 * `universityDomain` (PRODUCT_SPEC §3.2), so a hand-curated list of good
 * first-date spots per university is a small, high-quality PRIMARY source.
 * Google Places (`pickVenueAtMidpoint`) is kept only as the FALLBACK for
 * areas / categories we haven't curated yet.
 *
 * Ranking is fairness-aware: instead of "closest to the geometric midpoint",
 * we minimise `max(distA, distB)` — the *worse* of the two commutes — so we
 * never pick a venue that's central-on-paper but a long haul for one person.
 *
 * Tunables live here (next to the logic), matching the existing convention in
 * `venue.ts`/`geo.ts` where venue thresholds are module-local rather than in
 * the shared package.
 */

import { prisma } from "@gennety/db";
import { haversineDistanceKm, type LatLng } from "./geo.js";
import {
  isBlockedVenueName,
  pickVenueAtMidpoint,
  type Venue,
  type RegularOpeningHours,
} from "./venue.js";
import { VENUE_CATEGORY_WHITELIST, type VenueCategory } from "./vibe-parser.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Hard cap on the worse of the two commutes. A curated venue whose
 * `max(distA, distB)` exceeds this is not a sensible meeting point for the
 * pair, so we discard it (and fall through to Places if nothing else fits).
 */
export const CURATED_VENUE_MAX_COMMUTE_KM = 8;

/** Bonus multiplier when a venue's `vibeTags` intersect the merged keywords. */
export const CURATED_VENUE_VIBE_MATCH_BONUS = 1.1;

/** Distance factor floor so a great priority-1 spot isn't zeroed out by range. */
const DISTANCE_FACTOR_FLOOR = 0.4;

/** priority 1 → 1.0, 2 → 0.85, 3 → 0.7 (clamped). Lower priority = better. */
export function priorityWeight(priority: number): number {
  const p = Number.isFinite(priority) ? priority : 2;
  return Math.max(0.4, 1 - (Math.max(1, p) - 1) * 0.15);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal curated-venue shape the ranker needs (subset of the Prisma row). */
export interface CuratedVenueRow {
  name: string;
  address: string;
  lat: number;
  lng: number;
  googleMapsUri: string | null;
  category: string;
  priority: number;
  vibeTags: string[];
  utcOffsetMinutes: number | null;
  openingHours: RegularOpeningHours | null;
}

export interface ResolveVenueInput {
  universityDomain: string | null;
  midpoint: LatLng;
  originA: LatLng;
  originB: LatLng;
  radiusMeters: number;
  category: VenueCategory;
  keywords: string[];
  /** The locked-in date/time — used to skip venues closed at that slot. */
  agreedTime: Date;
}

interface RankContext {
  originA: LatLng;
  originB: LatLng;
  category: VenueCategory;
  keywords: string[];
  agreedTime: Date;
}

/** Injectable deps for testing `resolveVenue` without DB / network. */
export interface ResolveVenueDeps {
  pickCurated?: (input: ResolveVenueInput) => Promise<Venue | null>;
  pickPlaces?: (input: {
    lat: number;
    lng: number;
    category: VenueCategory;
    keywords: string[];
    radiusMeters: number;
  }) => Promise<Venue>;
}

// ---------------------------------------------------------------------------
// Pure ranking
// ---------------------------------------------------------------------------

/**
 * Distance factor for the worse commute: linear 1.0 → floor over the
 * acceptable-commute window. `maxDistKm = 0` → 1.0; at the cap → floor.
 */
function distanceFactor(maxDistKm: number): number {
  const f = 1 - (maxDistKm / CURATED_VENUE_MAX_COMMUTE_KM) * (1 - DISTANCE_FACTOR_FLOOR);
  return Math.max(DISTANCE_FACTOR_FLOOR, f);
}

function vibeBonus(tags: string[], keywords: string[]): number {
  if (keywords.length === 0 || tags.length === 0) return 1;
  const lowered = new Set(tags.map((t) => t.toLowerCase()));
  const hit = keywords.some((k) => lowered.has(k.toLowerCase()));
  return hit ? CURATED_VENUE_VIBE_MATCH_BONUS : 1;
}

/**
 * Filter curated rows to a category, applying the same product fallback as
 * `mergeParsed`: try the exact merged category, else the universal `cafe`
 * default, else accept any category rather than fall straight to Places.
 */
function filterByCategory(
  rows: CuratedVenueRow[],
  category: VenueCategory,
): CuratedVenueRow[] {
  const exact = rows.filter((r) => r.category === category);
  if (exact.length > 0) return exact;
  const cafe = rows.filter((r) => r.category === "cafe");
  if (cafe.length > 0) return cafe;
  return rows;
}

const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

/**
 * Whether a venue is open at a given instant, per Places `regularOpeningHours`.
 *
 * Pure + defensive: when we lack the data to decide (no hours, or no UTC offset
 * to localize the instant) we return `true` — we never filter a venue out on
 * missing information. `periods[]` uses day 0=Sunday…6=Saturday with local
 * `{hour,minute}`; an `open` with no `close` marks an always-open venue.
 * Handles windows that wrap past midnight / the week boundary.
 */
export function isVenueOpenAt(
  openingHours: RegularOpeningHours | null | undefined,
  utcOffsetMinutes: number | null | undefined,
  instant: Date,
): boolean {
  const periods = openingHours?.periods;
  if (!periods || periods.length === 0) return true;
  if (utcOffsetMinutes == null) return true;

  // Shift to the venue's local wall-clock, then read fields in UTC so the
  // server's own timezone doesn't leak in.
  const local = new Date(instant.getTime() + utcOffsetMinutes * 60_000);
  const cur = local.getUTCDay() * MINUTES_PER_DAY + local.getUTCHours() * 60 + local.getUTCMinutes();

  for (const period of periods) {
    if (!period.open) continue;
    const openAbs =
      (period.open.day ?? 0) * MINUTES_PER_DAY +
      (period.open.hour ?? 0) * 60 +
      (period.open.minute ?? 0);
    if (!period.close) return true; // open with no close → 24/7
    let closeAbs =
      (period.close.day ?? period.open.day ?? 0) * MINUTES_PER_DAY +
      (period.close.hour ?? 0) * 60 +
      (period.close.minute ?? 0);
    if (closeAbs <= openAbs) closeAbs += MINUTES_PER_WEEK; // wraps midnight / week end

    if ((cur >= openAbs && cur < closeAbs) ||
        (cur + MINUTES_PER_WEEK >= openAbs && cur + MINUTES_PER_WEEK < closeAbs)) {
      return true;
    }
  }
  return false;
}

/**
 * Pure ranker — pick the best curated row for the pair, or `null` if every
 * candidate sits beyond the max-commute cap or is closed at the agreed slot.
 * Exported for unit testing.
 */
export function rankCuratedVenues(
  rows: CuratedVenueRow[],
  ctx: RankContext,
): CuratedVenueRow | null {
  const candidates = filterByCategory(rows, ctx.category);
  let best: CuratedVenueRow | null = null;
  let bestScore = -Infinity;

  for (const row of candidates) {
    if (isBlockedVenueName(row.name)) continue;
    if (!isVenueOpenAt(row.openingHours, row.utcOffsetMinutes, ctx.agreedTime)) continue;
    const venuePoint: LatLng = { lat: row.lat, lng: row.lng };
    const distA = haversineDistanceKm(ctx.originA, venuePoint);
    const distB = haversineDistanceKm(ctx.originB, venuePoint);
    const maxDist = Math.max(distA, distB);
    if (maxDist > CURATED_VENUE_MAX_COMMUTE_KM) continue;

    const s =
      priorityWeight(row.priority) *
      distanceFactor(maxDist) *
      vibeBonus(row.vibeTags, ctx.keywords);

    if (s > bestScore) {
      bestScore = s;
      best = row;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// DB-backed pick + orchestrator
// ---------------------------------------------------------------------------

function rowToVenue(row: CuratedVenueRow): Venue {
  return {
    name: row.name,
    address: row.address,
    googleMapsUri: row.googleMapsUri,
  };
}

/**
 * Pick the best curated venue for a match, or `null` when there's no usable
 * curated option (no domain, no active rows, or all out of commute range) so
 * the caller can fall back to Places.
 */
export async function pickCuratedVenue(
  input: ResolveVenueInput,
): Promise<Venue | null> {
  if (!input.universityDomain) return null;

  const rows = await prisma.curatedVenue.findMany({
    where: { universityDomain: input.universityDomain, active: true },
    select: {
      name: true,
      address: true,
      lat: true,
      lng: true,
      googleMapsUri: true,
      category: true,
      priority: true,
      vibeTags: true,
      utcOffsetMinutes: true,
      openingHours: true,
    },
  });
  if (rows.length === 0) return null;

  const best = rankCuratedVenues(
    rows.map((r) => ({
      ...r,
      openingHours: (r.openingHours as RegularOpeningHours | null) ?? null,
    })),
    {
      originA: input.originA,
      originB: input.originB,
      category: input.category,
      keywords: input.keywords,
      agreedTime: input.agreedTime,
    },
  );
  return best ? rowToVenue(best) : null;
}

/**
 * Resolve the venue for a finalised match: curated-first, Places fallback.
 * Both finalize paths (bot `tryFinalize` and mobile `tryFinalizeMatchVenue`)
 * call this so the strategy lives in one place. `deps` is for tests only.
 */
export async function resolveVenue(
  input: ResolveVenueInput,
  deps: ResolveVenueDeps = {},
): Promise<Venue> {
  const pickCurated = deps.pickCurated ?? pickCuratedVenue;
  const pickPlaces = deps.pickPlaces ?? pickVenueAtMidpoint;

  const curated = await pickCurated(input);
  if (curated) return curated;

  return pickPlaces({
    lat: input.midpoint.lat,
    lng: input.midpoint.lng,
    category: input.category,
    keywords: input.keywords,
    radiusMeters: input.radiusMeters,
  });
}

/**
 * Validate a category string against the shared whitelist. Used by the seeder
 * import path to reject typos before they reach the DB.
 */
export function isValidVenueCategory(value: string): value is VenueCategory {
  return (VENUE_CATEGORY_WHITELIST as readonly string[]).includes(value);
}
