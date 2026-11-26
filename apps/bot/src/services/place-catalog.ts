/**
 * The city's places as the chat agent and its place scenes read them
 * (decision 2026-11-26, `docs/product/domains/agent-place-scenes.md`).
 *
 * Three jobs, kept apart from the tools that use them:
 *
 * 1. **The catalog of one city**, one entry per real place. The catalog holds a
 *    row per university domain, so copies are folded on the Google place id
 *    (a hand-entered row on its name and rounded point), the operator's best
 *    copy naming the place and the best copy with a photo lending it — the
 *    rules `frequent-places.ts` and the showcase already follow. Served from
 *    memory for ten minutes, like the showcase.
 * 2. **The clock and the walk** — pure: whether a place is open at an instant
 *    in its own wall-clock time, today's intervals, the label, and walking
 *    minutes between two points. No provider is asked; everything comes from
 *    the stored `openingHours` and `utcOffsetMinutes`.
 * 3. **The person's regular places** — only with the frequent-places opt-in,
 *    catalog places only (a visit is only ever recorded at a catalog venue,
 *    so home and work can never be one), top five by distinct days in the
 *    last 60, never the days themselves.
 */
import { prisma, type Prisma } from "@gennety/db";
import {
  DEFAULT_MARKET,
  PLACE_NEAR_REGULAR_M,
  PLACE_REGULARS_MAX,
  PLACE_REGULARS_MIN_DAYS,
  PLACE_REGULARS_WINDOW_DAYS,
  PLACE_SEARCH_LIMIT_DEFAULT,
  PLACE_SEARCH_LIMIT_MAX,
  PLACE_WALK_DETOUR,
  PLACE_WALK_MAX_M,
  PLACE_WALK_M_PER_MIN,
  cityKeyToTimeZone,
  findMarketByCityKey,
  t,
  type Language,
  type TranslationKey,
} from "@gennety/shared";
import { normalizeOpeningPeriods, showcasePriceLevel, type ShowcaseOpeningPeriod } from "./curated-venue.js";
import { localDay, shiftDay } from "./frequent-places-rules.js";
import { haversineDistanceKm } from "./geo.js";
import { isBlockedVenueName, type RegularOpeningHours } from "./venue.js";

const MINUTE_MS = 60_000;
const DAY_MIN = 1440;
const WEEK_MIN = DAY_MIN * 7;

/* ── the catalog ────────────────────────────────────────────────────────── */

/** One real place, everything a scene or a search result may say about it. */
export interface PlaceFacts {
  /** The naming copy's catalog id — what the scene and the search hand out. */
  id: string;
  placeId: string | null;
  /** Every catalog id of this place, so an id from any copy resolves. */
  ids: string[];
  name: string;
  address: string;
  category: string;
  lat: number;
  lng: number;
  utcOffsetMinutes: number | null;
  periods: ShowcaseOpeningPeriod[];
  /** The copy whose photo is shown, or null when no copy has one. */
  photoVenueId: string | null;
  rating: number | null;
  ratingCount: number | null;
  /** 0 free … 4 very expensive, Google's scale. */
  priceLevel: number | null;
  vibeTags: string[];
  facetTags: string[];
  summary: string | null;
  primaryType: string | null;
  mapsUri: string | null;
  createdAt: Date;
}

const PLACE_COLUMNS = {
  id: true,
  placeId: true,
  name: true,
  address: true,
  category: true,
  priority: true,
  lat: true,
  lng: true,
  utcOffsetMinutes: true,
  openingHours: true,
  photoRefs: true,
  rating: true,
  userRatingCount: true,
  priceLevel: true,
  vibeTags: true,
  facetTags: true,
  editorialSummary: true,
  primaryType: true,
  googleMapsUri: true,
  createdAt: true,
} satisfies Prisma.CuratedVenueSelect;

export type PlaceRow = Prisma.CuratedVenueGetPayload<{ select: typeof PLACE_COLUMNS }>;

const PRICE_SCALE: Record<string, number> = { free: 0, inexpensive: 1, moderate: 2, expensive: 3, very_expensive: 4 };

function placeKeyOf(row: Pick<PlaceRow, "placeId" | "name" | "lat" | "lng">): string {
  if (row.placeId) return `place:${row.placeId}`;
  return `name:${row.name.trim().toLocaleLowerCase()}@${row.lat.toFixed(4)},${row.lng.toFixed(4)}`;
}

function httpsOrNull(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Catalog rows → one entry per real place. Pure. Blocked names and rows
 * without a usable point are dropped; categories are all kept — this is where
 * a person goes, not what we propose for a first date.
 */
export function toPlaceFacts(rows: readonly PlaceRow[]): PlaceFacts[] {
  const ordered = [...rows].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const byKey = new Map<string, PlaceFacts>();
  for (const row of ordered) {
    if (isBlockedVenueName(row.name)) continue;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng) || (row.lat === 0 && row.lng === 0)) continue;
    const key = placeKeyOf(row);
    const hasPhoto = row.photoRefs.length > 0;
    const named = byKey.get(key);
    if (named) {
      named.ids.push(row.id);
      if (hasPhoto && !named.photoVenueId) named.photoVenueId = row.id;
      continue;
    }
    const summary = row.editorialSummary?.trim();
    const price = showcasePriceLevel(row.priceLevel);
    byKey.set(key, {
      id: row.id,
      placeId: row.placeId,
      ids: [row.id],
      name: row.name.trim(),
      address: row.address,
      category: row.category,
      lat: row.lat,
      lng: row.lng,
      utcOffsetMinutes: row.utcOffsetMinutes,
      periods: normalizeOpeningPeriods(row.openingHours as RegularOpeningHours | null),
      photoVenueId: hasPhoto ? row.id : null,
      rating: row.rating != null && row.rating >= 1 && row.rating <= 5 ? row.rating : null,
      ratingCount: row.userRatingCount != null && Number.isInteger(row.userRatingCount) && row.userRatingCount >= 0 ? row.userRatingCount : null,
      priceLevel: price ? PRICE_SCALE[price]! : null,
      vibeTags: row.vibeTags,
      facetTags: row.facetTags,
      summary: summary ? summary : null,
      primaryType: row.primaryType,
      mapsUri: httpsOrNull(row.googleMapsUri),
      createdAt: row.createdAt,
    });
  }
  return [...byKey.values()];
}

/** One city's places, with every copy's id and place id pointing at its entry. */
export interface PlaceCatalog {
  cityKey: string;
  places: PlaceFacts[];
  byId: ReadonlyMap<string, PlaceFacts>;
}

export function indexPlaces(cityKey: string, places: PlaceFacts[]): PlaceCatalog {
  const byId = new Map<string, PlaceFacts>();
  for (const place of places) {
    for (const id of place.ids) byId.set(id, place);
    if (place.placeId) byId.set(place.placeId, place);
  }
  return { cityKey, places, byId };
}

export const PLACE_CATALOG_TTL_MS = 10 * MINUTE_MS;
const CATALOG_MAX_CITIES = 16;
const catalogCache = new Map<string, { at: number; catalog: PlaceCatalog }>();

/** The person's city: their home city when it is a market, else the default market. */
export function placeCityOf(homeCityKey: string | null | undefined): string {
  return (findMarketByCityKey(homeCityKey) ?? DEFAULT_MARKET).cityKey;
}

/** Every active place of one city. `now` is for tests. */
export async function placeCatalogForCity(cityKey: string, now: number = Date.now()): Promise<PlaceCatalog> {
  const cached = catalogCache.get(cityKey);
  if (cached && now - cached.at < PLACE_CATALOG_TTL_MS) return cached.catalog;
  const rows = await prisma.curatedVenue.findMany({ where: { cityKey, active: true }, select: PLACE_COLUMNS });
  const catalog = indexPlaces(cityKey, toPlaceFacts(rows));
  catalogCache.delete(cityKey);
  catalogCache.set(cityKey, { at: now, catalog });
  while (catalogCache.size > CATALOG_MAX_CITIES) {
    const oldest = catalogCache.keys().next().value;
    if (oldest === undefined) break;
    catalogCache.delete(oldest);
  }
  return catalog;
}

/** Test-only. */
export function resetPlaceCatalogCache(): void {
  catalogCache.clear();
}

/* ── the clock ──────────────────────────────────────────────────────────── */

export interface PlaceClock {
  /** Venue-local time of `now`, "HH:mm"; null without a UTC offset. */
  nowLocal: string | null;
  /** Null when the hours or the offset are unknown — never a guess. */
  openNow: boolean | null;
  /** Today's intervals, local "HH:mm"; a close past midnight reads "02:00", a 24-hour day "00:00"–"24:00". */
  today: Array<{ open: string; close: string }>;
  /** «до 23:00», «откроется в 9:00», «круглосуточно»… in the person's language; null when unknown. */
  hoursLabel: string | null;
  /** Minutes until it closes (open) or opens (closed); null when unknown. */
  minutesToChange: number | null;
}

const UNKNOWN_CLOCK: PlaceClock = { nowLocal: null, openNow: null, today: [], hoursLabel: null, minutesToChange: null };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:mm" of a minute of the day (0…1440). */
function hhmm(minuteOfDay: number): string {
  return `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;
}

/** "H:mm" for a label: «до 2:00», «в 9:00». */
function hmm(minuteOfDay: number): string {
  const m = ((minuteOfDay % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

function weekMinute(point: { day: number; hour: number; minute: number }): number {
  return point.day * DAY_MIN + point.hour * 60 + point.minute;
}

/**
 * Opening windows on a three-week line (last week, this week, next week),
 * merged where one ends as the next begins (a close at 24:00 and an open at
 * 00:00 are one evening). Week minutes, day 0 = Sunday, like Google.
 */
function mergedWindows(periods: readonly ShowcaseOpeningPeriod[]): Array<[number, number]> | "always" {
  const raw: Array<[number, number]> = [];
  for (const period of periods) {
    if (!period.close) return "always";
    const open = weekMinute(period.open);
    let close = weekMinute(period.close);
    if (close <= open) close += WEEK_MIN;
    for (const shift of [-WEEK_MIN, 0, WEEK_MIN]) raw.push([open + shift, close + shift]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const window of raw) {
    const last = merged.at(-1);
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
    else merged.push([window[0], window[1]]);
  }
  if (merged.some(([open, close]) => close - open >= WEEK_MIN)) return "always";
  return merged;
}

/**
 * Whether a place is open at `now` in its own wall-clock time, today's
 * intervals and the label. Pure. Unknown hours or an unknown offset give an
 * unknown answer, never «closed» — the same reading the venue engine uses.
 */
export function placeClock(
  periods: readonly ShowcaseOpeningPeriod[],
  utcOffsetMinutes: number | null,
  now: Date,
  language: Language,
): PlaceClock {
  if (utcOffsetMinutes == null || !Number.isFinite(utcOffsetMinutes)) return UNKNOWN_CLOCK;
  const local = new Date(now.getTime() + utcOffsetMinutes * MINUTE_MS);
  const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  const cur = local.getUTCDay() * DAY_MIN + minuteOfDay;
  const nowLocal = hhmm(minuteOfDay);
  if (periods.length === 0) return { ...UNKNOWN_CLOCK, nowLocal };

  const windows = mergedWindows(periods);
  if (windows === "always") {
    return { nowLocal, openNow: true, today: [{ open: "00:00", close: "24:00" }], hoursLabel: t(language, "placeOpenAllDay"), minutesToChange: null };
  }

  const dayStart = cur - minuteOfDay;
  const dayEnd = dayStart + DAY_MIN;
  const today = windows
    .filter(([open, close]) => open < dayEnd && close > dayStart)
    .map(([open, close]) => {
      const from = Math.max(open, dayStart) - dayStart;
      const to = close - dayStart;
      // A window that covers the rest of the day and beyond is the whole day.
      return { open: hhmm(from), close: to - from >= DAY_MIN ? "24:00" : hhmm(to % DAY_MIN) };
    });

  const current = windows.find(([open, close]) => open <= cur && cur < close);
  if (current) {
    return {
      nowLocal,
      openNow: true,
      today,
      hoursLabel: t(language, "placeOpenUntil", { time: hmm(current[1] - dayStart) }),
      minutesToChange: current[1] - cur,
    };
  }
  const next = windows.find(([open]) => open > cur);
  if (!next) return { nowLocal, openNow: false, today, hoursLabel: t(language, "placeClosedNow"), minutesToChange: null };
  const at = next[0] - dayStart;
  const hoursLabel =
    at < DAY_MIN
      ? t(language, "placeOpensAt", { time: hmm(at) })
      : at < 2 * DAY_MIN
        ? t(language, "placeOpensTomorrow", { time: hmm(at) })
        : t(language, "placeClosedNow");
  return { nowLocal, openNow: false, today, hoursLabel, minutesToChange: next[0] - cur };
}

/* ── the walk ───────────────────────────────────────────────────────────── */

export interface PlaceWalk {
  distanceM: number;
  /** Null beyond `PLACE_WALK_MAX_M`: nobody walks that. */
  walkMinutes: number | null;
}

export function placeWalk(from: { lat: number; lng: number }, to: { lat: number; lng: number }): PlaceWalk {
  const distanceM = Math.round(haversineDistanceKm(from, to) * 1000);
  const walkMinutes = distanceM > PLACE_WALK_MAX_M
    ? null
    : Math.max(1, Math.round((distanceM * PLACE_WALK_DETOUR) / PLACE_WALK_M_PER_MIN));
  return { distanceM, walkMinutes };
}

/* ── labels ─────────────────────────────────────────────────────────────── */

const CATEGORY_LABEL: Record<string, TranslationKey> = {
  cafe: "placeCategoryCafe",
  coffee_shop: "placeCategoryCoffeeShop",
  restaurant: "placeCategoryRestaurant",
  park: "placeCategoryPark",
  museum: "placeCategoryMuseum",
  lounge: "placeCategoryLounge",
};

export function placeCategoryLabel(category: string, language: Language): string | null {
  const key = CATEGORY_LABEL[category];
  return key ? t(language, key) : null;
}

/* ── the person's regular places ────────────────────────────────────────── */

export interface RegularPlace {
  /** The Google place id — what `anchor_ids` names. */
  anchorId: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  /** Distinct days with a visit in the window. */
  visits: number;
}

/**
 * Visit days → the top places. Pure. Places the person hid, places the city's
 * catalog no longer holds and places under `PLACE_REGULARS_MIN_DAYS` drop out.
 */
export function rankRegulars(input: {
  visits: ReadonlyArray<{ placeId: string; day: string }>;
  catalog: PlaceCatalog;
  hidden: ReadonlySet<string>;
  firstDay: string;
}): RegularPlace[] {
  const days = new Map<string, Set<string>>();
  for (const visit of input.visits) {
    if (visit.day < input.firstDay || input.hidden.has(visit.placeId)) continue;
    const set = days.get(visit.placeId) ?? new Set<string>();
    set.add(visit.day);
    days.set(visit.placeId, set);
  }
  const out: RegularPlace[] = [];
  for (const [placeId, set] of days) {
    if (set.size < PLACE_REGULARS_MIN_DAYS) continue;
    const place = input.catalog.byId.get(placeId);
    if (!place) continue;
    out.push({ anchorId: placeId, name: place.name, category: place.category, lat: place.lat, lng: place.lng, visits: set.size });
  }
  out.sort((a, b) => b.visits - a.visits || (a.anchorId < b.anchorId ? -1 : 1));
  return out.slice(0, PLACE_REGULARS_MAX);
}

function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * The person's regular places, or null when they switched frequent places
 * off. Reads the visit log and the dates they attended (a date is a visit,
 * `frequent-places.md`), in their city's zone.
 */
export async function loadRegulars(
  userId: string,
  catalog: PlaceCatalog,
  now: number = Date.now(),
): Promise<RegularPlace[] | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { frequentPlacesOptIn: true } });
  if (!user?.frequentPlacesOptIn) return null;
  const zone = cityKeyToTimeZone(catalog.cityKey);
  const firstDay = shiftDay(localDay(now, zone), -(PLACE_REGULARS_WINDOW_DAYS - 1));
  const [rows, dates, hidden] = await Promise.all([
    prisma.userPlaceVisit.findMany({
      where: { userId, visitDay: { gte: dayToDate(firstDay) } },
      select: { placeId: true, visitDay: true },
    }),
    prisma.match.findMany({
      where: {
        OR: [
          { userAId: userId, dateAttendedA: true },
          { userBId: userId, dateAttendedB: true },
        ],
        venuePlaceId: { not: null },
        agreedTime: { gte: new Date(dayToDate(firstDay).getTime() - 86_400_000) },
      },
      select: { venuePlaceId: true, agreedTime: true },
    }),
    prisma.userHiddenPlace.findMany({ where: { userId }, select: { placeId: true } }),
  ]);
  const visits = rows.map((row) => ({ placeId: row.placeId, day: row.visitDay.toISOString().slice(0, 10) }));
  for (const date of dates) {
    if (date.venuePlaceId && date.agreedTime) visits.push({ placeId: date.venuePlaceId, day: localDay(date.agreedTime.getTime(), zone) });
  }
  return rankRegulars({ visits, catalog, hidden: new Set(hidden.map((h) => h.placeId)), firstDay });
}

/* ── search ─────────────────────────────────────────────────────────────── */

export interface PlaceSearchQuery {
  query?: string | null;
  category?: string | null;
  /** A point the results are ranked by distance from. */
  near?: { lat: number; lng: number } | null;
  openNow?: boolean;
  limit?: number;
}

export interface PlaceSearchHit {
  place: PlaceFacts;
  clock: PlaceClock;
  /** From `near`, when given. */
  walk: PlaceWalk | null;
  /** The closest of their regular places, when they have any. */
  nearestRegular: { regular: RegularPlace; walk: PlaceWalk } | null;
}

function words(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
}

const CATEGORY_WORDS: Record<string, string[]> = {
  cafe: ["cafe", "кафе", "café"],
  coffee_shop: ["coffee", "кофе", "кава", "кофейня", "кавярня", "kawa", "kaffee"],
  restaurant: ["restaurant", "ресторан", "restauracja", "dinner", "ужин", "вечеря"],
  park: ["park", "парк"],
  museum: ["museum", "музей", "muzeum"],
  lounge: ["bar", "бар", "lounge", "коктейль", "cocktail", "wine", "вино"],
};

/** How many query words a place answers to. Pure. */
export function queryScore(place: PlaceFacts, queryWords: readonly string[]): number {
  if (queryWords.length === 0) return 0;
  const hay = new Set(
    words(
      [place.name, place.address, place.summary ?? "", place.primaryType ?? "", ...place.vibeTags, ...place.facetTags, ...(CATEGORY_WORDS[place.category] ?? [])].join(" "),
    ),
  );
  let score = 0;
  for (const q of queryWords) {
    if (hay.has(q)) score += 2;
    else if (q.length >= 4 && [...hay].some((w) => w.startsWith(q.slice(0, Math.max(4, q.length - 2))))) score += 1;
  }
  return score;
}

/**
 * Search one city's places. Pure. A query must hit at least one word; then
 * the hits rank by how much of the query they answer, by distance from `near`
 * (or, without it, places near the person's regulars first), then by Google's
 * rating weighted by its count.
 */
export function searchPlaces(
  catalog: PlaceCatalog,
  query: PlaceSearchQuery,
  context: { now: Date; language: Language; regulars: readonly RegularPlace[] },
): PlaceSearchHit[] {
  const limit = Math.min(PLACE_SEARCH_LIMIT_MAX, Math.max(1, Math.round(query.limit ?? PLACE_SEARCH_LIMIT_DEFAULT)));
  const queryWords = words(query.query ?? "");
  const scored: Array<{ hit: PlaceSearchHit; score: number; nearKey: number; quality: number }> = [];
  for (const place of catalog.places) {
    if (query.category && place.category !== query.category) continue;
    const score = queryScore(place, queryWords);
    if (queryWords.length > 0 && score === 0) continue;
    const clock = placeClock(place.periods, place.utcOffsetMinutes, context.now, context.language);
    if (query.openNow && clock.openNow === false) continue;
    const walk = query.near ? placeWalk(query.near, place) : null;
    let nearestRegular: PlaceSearchHit["nearestRegular"] = null;
    for (const regular of context.regulars) {
      if (place.placeId === regular.anchorId) continue;
      const w = placeWalk(regular, place);
      if (!nearestRegular || w.distanceM < nearestRegular.walk.distanceM) nearestRegular = { regular, walk: w };
    }
    const nearKey = walk
      ? walk.distanceM
      : nearestRegular && nearestRegular.walk.distanceM <= PLACE_NEAR_REGULAR_M
        ? 0
        : 1;
    const quality = (place.rating ?? 3.5) * Math.log10(10 + (place.ratingCount ?? 0));
    scored.push({ hit: { place, clock, walk, nearestRegular }, score, nearKey, quality });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.nearKey - b.nearKey ||
      b.quality - a.quality ||
      (a.hit.place.id < b.hit.place.id ? -1 : 1),
  );
  return scored.slice(0, limit).map((entry) => entry.hit);
}
