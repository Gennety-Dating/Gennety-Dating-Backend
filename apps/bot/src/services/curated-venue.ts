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
  fetchPlacePhotoName,
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
  /**
   * Stable Google Places id. What `resolveVenue` falls back to when the row
   * carries no {@link photoRefs} yet, to pull a cover photo at assignment time
   * (see `fetchPlacePhotoName`). Null for rows seeded without one — those
   * simply get no photo.
   */
  placeId: string | null;
  /**
   * Photo resource names the nightly re-validation cron already wrote onto this
   * row. Reading them here is what makes the cover FREE for a scanned venue:
   * before 2026-08-23 this file hardcoded `photoName: null` and then paid a
   * Place Details request per assignment, even though the answer was sitting in
   * the column. Empty means "the scan has not reached this row yet", which is
   * the one case that still costs a lookup.
   */
  photoRefs?: string[];
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

/**
 * Map a curated row to the shared `Venue` shape.
 *
 * Exported for a direct unit test, the same reason `rankCuratedVenues` is:
 * reaching it through `pickCuratedVenue` would mean mocking Prisma in a file
 * that deliberately touches neither the DB nor Places, and the one line worth
 * pinning here (the cover coming off the row) is pure mapping.
 */
export function rowToVenue(row: CuratedVenueRow): Venue {
  return {
    name: row.name,
    address: row.address,
    googleMapsUri: row.googleMapsUri,
    placeId: row.placeId,
    source: "curated",
    // Координаты площадки. В строке они есть всегда (`lat`/`lng` в схеме
    // не-nullable), но сюда не переносились — и финализаторы, которым нечего
    // было записать, писали в `Match.venueLat/Lng` середину маршрута. Отсюда
    // и росла двусмысленность колонки: Date Bump со своими 100 метрами
    // сверял человека с точкой в километре от столика
    // (аудит 2026-09-06, «Архитектура №1»; см. `services/venue-location.ts`).
    lat: row.lat,
    lng: row.lng,
    // Read straight off the row when the nightly re-validation cron has already
    // resolved it. `resolveVenue` below only pays a Place Details request when
    // this is still null, i.e. for a venue the scan has not reached — which is
    // the whole reason `photoRefs` is written in the first place. It was being
    // written and never read: this file hardcoded null and then bought the same
    // answer again on every assignment.
    photoName: row.photoRefs?.[0] ?? null,
    // Curated rows carry no Places editorial summary / rating; expose the
    // operator category so the blurb still has an honest grounding fact, and
    // let it fall back to the match's requested vibe for the rest.
    editorialSummary: null,
    rating: null,
    userRatingCount: null,
    primaryType: row.category,
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
    // Auto-assign only ever picks a `base` venue — the default date must respect
    // the student-friendly ≤ MODERATE cap. Premium venues are opt-in via a paid
    // venue change, never the automatic first assignment (PRODUCT_SPEC §Premium).
    where: { universityDomain: input.universityDomain, active: true, tier: "base" },
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
      placeId: true,
      photoRefs: true,
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
  if (curated) {
    // The cover normally arrives free: `rowToVenue` reads `photoRefs[0]` off the
    // row, which the nightly re-validation cron fills. `??` short-circuits, so
    // the Places request below runs ONLY for a venue the scan has not reached
    // yet — a new row, or one whose scan is still pending. Without a cover of
    // some kind the date card falls back to its plain gradient, which is what
    // this fallback exists to prevent.
    return {
      ...curated,
      photoName:
        curated.photoName ??
        (await fetchPlacePhotoName(process.env.PLACES_API_KEY, curated.placeId)),
    };
  }

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

/**
 * Curated-venue tiers (PRODUCT_SPEC §Premium / §3.7b). The tier decides which
 * POOL a venue belongs to, and only `base` is ever auto-assigned:
 *
 * - `base` — the default student-friendly pool (≤ MODERATE price cap). The
 *   only tier the concierge picks for the first, automatic assignment.
 * - `premium` — may exceed the price cap; shown-but-LOCKED in the venue-change
 *   board unless a participant has an active Gennety Premium subscription.
 * - `alternative` — operator-classified heavier cuisine (Georgian, Uzbek,
 *   Azerbaijani, Middle-Eastern, Central-Asian and similar). A perfectly good
 *   venue, but not a call Gennety makes FOR a pair on a first date: it only
 *   surfaces in the venue-change board, unlocked and priced like base, where
 *   the couple chooses it themselves. Not a price tier — no Premium gate.
 *
 * Whitelist-validated in app code, not a Prisma enum (mirrors `category`).
 */
export const VENUE_TIER_WHITELIST = ["base", "premium", "alternative"] as const;
export type VenueTier = (typeof VENUE_TIER_WHITELIST)[number];

/** Validate a tier string; used by the seeder import path before DB writes. */
export function isValidVenueTier(value: string): value is VenueTier {
  return (VENUE_TIER_WHITELIST as readonly string[]).includes(value);
}

/**
 * Categories the product does not offer as a date venue, on EITHER surface —
 * neither the automatic first assignment nor the paid venue-change board.
 *
 * `museum` (founder decision 2026-07-31): a museum is a poor default for a
 * first meeting — timed, ticketed, quiet in the wrong way, and closing early
 * enough that it rules out most of the evening slot grid. The rows stay in the
 * catalog `active` rather than being deleted: they cost nothing, they keep
 * their curation, and re-enabling the category is removing one entry here.
 *
 * NOTE this does not empty the `art_culture` experience. That facet is also
 * carried through `vibeTags` by book cafes, art bars and historic streets
 * (7 venues in the Kyiv catalog at the time of the decision), so a pair asking
 * for art still has real inventory — arguably better suited to a first date
 * than a museum was.
 */
export const EXCLUDED_VENUE_CATEGORIES: readonly VenueCategory[] = ["museum"];

/** Prisma-ready form of the exclusion, for a `category: { notIn }` filter. */
export const OFFERABLE_CATEGORY_FILTER: string[] = [...EXCLUDED_VENUE_CATEGORIES];

/** True when the product may offer this category as a date venue. */
export function isOfferableVenueCategory(category: string): boolean {
  return !(EXCLUDED_VENUE_CATEGORIES as readonly string[]).includes(category);
}

// ---------------------------------------------------------------------------
// Standby showcase — the iOS canvas while nothing is scheduled
// ---------------------------------------------------------------------------

/**
 * How many places the standby canvas shows.
 *
 * Each one is drawn twice — a photo pin on the map and a card in the carousel
 * under it — and Kyiv alone holds ~275 distinct places. All of them would be a
 * map buried under thumbnails and a carousel nobody reaches the end of; two
 * dozen is the city's best, each one swipe from the next.
 */
export const SHOWCASE_LIMIT = 24;

/**
 * How long one city's selection is served from memory. The catalog changes by
 * an operator import or the nightly re-validation, never by the minute, while
 * every canvas open in a city asks the same question — reading ~1,000 rows with
 * their opening-hours JSON on each open would be paying for an answer we hold.
 */
export const SHOWCASE_CACHE_TTL_MS = 10 * 60 * 1000;

/** Cities remembered at once — bounds the cache against junk keys. */
const SHOWCASE_CACHE_MAX_CITIES = 32;

/** The catalog columns the showcase reads (a subset of the Prisma row). */
export interface ShowcaseCandidate {
  id: string;
  placeId: string | null;
  name: string;
  address: string;
  category: string;
  priority: number;
  lat: number;
  lng: number;
  editorialSummary: string | null;
  vibeTags: string[];
  facetTags: string[];
  utcOffsetMinutes: number | null;
  openingHours: RegularOpeningHours | null;
  photoRefs: string[];
  rating: number | null;
  userRatingCount: number | null;
}

/** A moment of the venue's week, in its own wall-clock time (day 0 = Sunday). */
export interface ShowcaseOpeningPoint {
  day: number;
  hour: number;
  minute: number;
}

/** One opening window. No `close` is how Google says "around the clock". */
export interface ShowcaseOpeningPeriod {
  open: ShowcaseOpeningPoint;
  close?: ShowcaseOpeningPoint;
}

/**
 * One place as the canvas receives it, minus the photo links: those are signed
 * per response (`public/showcase-photos.ts`), so only whether there IS a photo
 * is decided here. The Places resource name never leaves the server.
 */
export interface ShowcasePlace {
  id: string;
  placeId: string | null;
  name: string;
  address: string;
  category: string;
  lat: number;
  lng: number;
  editorialSummary: string | null;
  vibeTags: string[];
  facetTags: string[];
  utcOffsetMinutes: number | null;
  openingHours: ShowcaseOpeningPeriod[];
  hasPhoto: boolean;
}

/**
 * Which rows are copies of one real place.
 *
 * The catalog holds a row per university domain, so one café in Podil can be
 * three rows with three ids — on the map, three pins stacked on one spot. The
 * Google place id is the real identity (the Scratch Map keys on it for the same
 * reason); a hand-entered row without one falls back to its name and a position
 * rounded to ~10 m.
 */
function placeKey(row: ShowcaseCandidate): string {
  if (row.placeId) return `place:${row.placeId}`;
  return `name:${row.name.trim().toLocaleLowerCase()}@${row.lat.toFixed(4)},${row.lng.toFixed(4)}`;
}

/**
 * Showcase order: the operator's own verdict first (`priority`, 1 = best
 * first-date spot), then a photo — a card without one is the one thing on this
 * screen that looks broken — then Google's rating and how many people gave it.
 * The id last, so equal places always come out in the same order.
 */
function compareShowcase(a: ShowcaseCandidate, b: ShowcaseCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const photoA = a.photoRefs.length > 0 ? 0 : 1;
  const photoB = b.photoRefs.length > 0 ? 0 : 1;
  if (photoA !== photoB) return photoA - photoB;
  const ratingA = a.rating ?? -1;
  const ratingB = b.rating ?? -1;
  if (ratingA !== ratingB) return ratingB - ratingA;
  const votesA = a.userRatingCount ?? -1;
  const votesB = b.userRatingCount ?? -1;
  if (votesA !== votesB) return votesB - votesA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Pure selection: one copy per real place, the product's standing exclusions
 * applied, the best {@link SHOWCASE_LIMIT} kept, in walking order.
 *
 * The exclusions are the ones that already hold everywhere else — a category
 * the product never offers (`museum`) and an operator-blocked name. The tier is
 * NOT filtered: the founder's brief asks for every active place, and a tier
 * decides who pays for a venue change, not whether a place is worth seeing.
 */
export function selectShowcase(
  rows: ShowcaseCandidate[],
  limit: number = SHOWCASE_LIMIT,
): ShowcaseCandidate[] {
  const byPlace = new Map<string, ShowcaseCandidate>();
  for (const row of rows) {
    if (!isOfferableVenueCategory(row.category)) continue;
    if (isBlockedVenueName(row.name)) continue;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    const key = placeKey(row);
    const seen = byPlace.get(key);
    byPlace.set(key, seen && compareShowcase(seen, row) <= 0 ? seen : row);
  }
  const chosen = [...byPlace.values()].sort(compareShowcase).slice(0, Math.max(0, limit));
  return orderAsWalk(chosen);
}

/**
 * Order places so that neighbouring cards are neighbouring pins.
 *
 * The carousel moves the map: every swipe flies the camera to the next card's
 * pin. In ranking order that flight would cross the city on every swipe; as a
 * walk — start at the best place, then always the nearest one not yet shown —
 * it is a street or two, and the map reads as a route rather than a slideshow.
 * Greedy nearest-neighbour rather than an optimal tour: with two dozen stops the
 * difference is invisible, and the first card must stay the best place.
 */
export function orderAsWalk<T extends { lat: number; lng: number }>(places: T[]): T[] {
  if (places.length <= 2) return [...places];
  const remaining = [...places];
  const walk: T[] = [remaining.shift()!];
  while (remaining.length > 0) {
    const here = walk[walk.length - 1];
    let nearest = 0;
    let nearestKm = Infinity;
    remaining.forEach((place, index) => {
      const km = haversineDistanceKm(here, place);
      if (km < nearestKm) {
        nearestKm = km;
        nearest = index;
      }
    });
    walk.push(remaining.splice(nearest, 1)[0]);
  }
  return walk;
}

type RawOpeningPoint = { day?: number | null; hour?: number | null; minute?: number | null };

function openingPoint(raw: RawOpeningPoint | null | undefined): ShowcaseOpeningPoint | null {
  if (!raw) return null;
  const day = raw.day ?? 0;
  const hour = raw.hour ?? 0;
  const minute = raw.minute ?? 0;
  if (![day, hour, minute].every((n) => Number.isInteger(n))) return null;
  // 24 is legal in the hour: some sources write the end of a day as 24:00.
  if (day < 0 || day > 6 || hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  return { day, hour, minute };
}

/**
 * Google's `regularOpeningHours.periods`, reduced to plain integers a client can
 * do arithmetic on. Missing fields read as zero — the same reading
 * {@link isVenueOpenAt} uses, so the canvas and the concierge never disagree
 * about whether a place is open. A period that cannot be read is dropped rather
 * than guessed at; an empty list means "unknown", never "closed all week".
 */
export function normalizeOpeningPeriods(
  hours: RegularOpeningHours | null | undefined,
): ShowcaseOpeningPeriod[] {
  const periods: ShowcaseOpeningPeriod[] = [];
  for (const period of hours?.periods ?? []) {
    const open = openingPoint(period?.open);
    if (!open) continue;
    if (!period.close) {
      periods.push({ open });
      continue;
    }
    const close = openingPoint(period.close);
    if (!close) continue;
    periods.push({ open, close });
  }
  return periods;
}

function toShowcasePlace(row: ShowcaseCandidate): ShowcasePlace {
  const summary = row.editorialSummary?.trim();
  return {
    id: row.id,
    placeId: row.placeId,
    name: row.name,
    address: row.address,
    category: row.category,
    lat: row.lat,
    lng: row.lng,
    editorialSummary: summary ? summary : null,
    vibeTags: row.vibeTags,
    facetTags: row.facetTags,
    utcOffsetMinutes: row.utcOffsetMinutes,
    openingHours: normalizeOpeningPeriods(row.openingHours),
    hasPhoto: row.photoRefs.length > 0,
  };
}

const showcaseCache = new Map<string, { at: number; places: ShowcasePlace[] }>();

/**
 * The standby canvas's places for one city, in display order. `now` is for
 * tests; callers pass nothing.
 */
export async function getShowcaseVenues(
  cityKey: string,
  now: number = Date.now(),
): Promise<ShowcasePlace[]> {
  const cached = showcaseCache.get(cityKey);
  if (cached && now - cached.at < SHOWCASE_CACHE_TTL_MS) return cached.places;

  const rows = await prisma.curatedVenue.findMany({
    where: { cityKey, active: true, category: { notIn: OFFERABLE_CATEGORY_FILTER } },
    select: {
      id: true,
      placeId: true,
      name: true,
      address: true,
      category: true,
      priority: true,
      lat: true,
      lng: true,
      editorialSummary: true,
      vibeTags: true,
      facetTags: true,
      utcOffsetMinutes: true,
      openingHours: true,
      photoRefs: true,
      rating: true,
      userRatingCount: true,
    },
  });

  const places = selectShowcase(
    rows.map((r) => ({
      ...r,
      openingHours: (r.openingHours as RegularOpeningHours | null) ?? null,
    })),
  ).map(toShowcasePlace);

  showcaseCache.delete(cityKey);
  if (showcaseCache.size >= SHOWCASE_CACHE_MAX_CITIES) {
    const oldest = showcaseCache.keys().next().value;
    if (oldest !== undefined) showcaseCache.delete(oldest);
  }
  showcaseCache.set(cityKey, { at: now, places });
  return places;
}

/** Test-only: forget every cached selection. */
export function resetShowcaseCache(): void {
  showcaseCache.clear();
}

/**
 * The cover photo of one catalog row, for the signed photo route — or null when
 * the row is gone, retired, or not yet reached by the nightly scan. A retired
 * row answering nothing is what makes its already-minted links stop with it.
 */
export async function showcasePhotoRef(venueId: string): Promise<string | null> {
  const row = await prisma.curatedVenue.findUnique({
    where: { id: venueId },
    select: { active: true, photoRefs: true },
  });
  if (!row?.active) return null;
  return row.photoRefs[0] ?? null;
}
