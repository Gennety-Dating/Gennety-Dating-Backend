/**
 * Frequently visited places — the pure half (docs/product/domains/
 * frequent-places.md): which catalog place one fix belongs to, when a run of
 * fixes becomes a visit, and how visits become the places a profile shows.
 *
 * No clock, no database, no network. `frequent-places.ts` feeds these and
 * stores what they decide — the same split `date-radar.ts` keeps between its
 * arithmetic and its in-memory map.
 */
import {
  FREQUENT_PLACE_AMBIGUITY_MARGIN_M,
  FREQUENT_PLACE_HALF_LIFE_DAYS,
  FREQUENT_PLACE_MAX_ACCURACY_M,
  FREQUENT_PLACE_MIN_DWELL_MINUTES,
  FREQUENT_PLACE_PER_CATEGORY_LIMIT,
  FREQUENT_PLACE_PROFILE_LIMIT,
  FREQUENT_PLACE_RULES,
  FREQUENT_PLACE_WINDOW_DAYS,
  type FrequentPlaceCategory,
} from "@gennety/shared";

import { haversineDistanceKm } from "./geo.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// One fix against the catalog
// ---------------------------------------------------------------------------

/** One real place of the catalog: one per Google place id, never one per row. */
export interface CatalogPlace {
  placeId: string;
  name: string;
  category: FrequentPlaceCategory;
  lat: number;
  lng: number;
}

/** A position as the phone reported it. */
export interface Fix {
  lat: number;
  lng: number;
  /** Radius of uncertainty in metres (iOS `horizontalAccuracy`). */
  accuracyM: number;
}

/**
 * What one fix says:
 * - `place` — inside one catalog place, and clearly that one;
 * - `unclear` — too vague, near a place but not inside it, or between two
 *   places too close to tell apart. It proves nothing, so it moves nothing;
 * - `away` — clear of every catalog place even allowing for the fix's own
 *   error: whatever stay was open is over.
 */
export type FixReading =
  | { kind: "place"; placeId: string; category: FrequentPlaceCategory }
  | { kind: "unclear" }
  | { kind: "away" };

/** A fix the rest of this module may reason about at all. */
export function isUsableFix(fix: Fix): boolean {
  return (
    Number.isFinite(fix.lat) &&
    Number.isFinite(fix.lng) &&
    Math.abs(fix.lat) <= 90 &&
    Math.abs(fix.lng) <= 180 &&
    Number.isFinite(fix.accuracyM) &&
    fix.accuracyM >= 0 &&
    fix.accuracyM <= FREQUENT_PLACE_MAX_ACCURACY_M
  );
}

/**
 * Which catalog place a fix is at, if any.
 *
 * Linear over the city: Kyiv is ~270 real places, so this is a few hundred
 * haversines — microseconds, with no index to keep and no query to run. A
 * spatial index (PostGIS, a geohash bucket map) would start to pay two orders
 * of magnitude later.
 *
 * Two rules keep a dense street honest. The runner-up is taken over EVERY
 * place, not only those whose radius the fix is inside — someone standing
 * between two cafés 10 m apart is between them whichever circle the dot
 * happens to fall in. And `away` needs the fix clear of every place by its
 * radius PLUS the fix's own error, so GPS jitter at a table reads as unclear
 * rather than as leaving.
 */
export function readFix(fix: Fix, places: readonly CatalogPlace[]): FixReading {
  if (!isUsableFix(fix)) return { kind: "unclear" };

  let nearest: { place: CatalogPlace; metres: number } | null = null;
  let runnerUpMetres = Infinity;
  let withinReach = false;

  for (const place of places) {
    const metres = haversineDistanceKm(fix, place) * 1000;
    if (metres <= FREQUENT_PLACE_RULES[place.category].radiusM + fix.accuracyM) {
      withinReach = true;
    }
    if (!nearest || metres < nearest.metres) {
      if (nearest) runnerUpMetres = nearest.metres;
      nearest = { place, metres };
    } else if (metres < runnerUpMetres) {
      runnerUpMetres = metres;
    }
  }

  if (!nearest || !withinReach) return { kind: "away" };
  if (nearest.metres > FREQUENT_PLACE_RULES[nearest.place.category].radiusM) {
    return { kind: "unclear" };
  }
  if (runnerUpMetres - nearest.metres < FREQUENT_PLACE_AMBIGUITY_MARGIN_M) {
    return { kind: "unclear" };
  }
  return { kind: "place", placeId: nearest.place.placeId, category: nearest.place.category };
}

/** What a client needs to decide whether a fix is worth sending. */
export interface Fence {
  lat: number;
  lng: number;
  radiusM: number;
}

/**
 * The city's places as circles for the client's pre-filter. A client sends a
 * fix only when it is within `radiusM` + its own accuracy of some fence — the
 * same reach {@link readFix} calls "not away" — so the pre-filter can never
 * drop a fix the server would have counted, and a position leaves the phone
 * only when the person is at one of our places.
 */
export function fencesFor(places: readonly CatalogPlace[]): Fence[] {
  return places.map((place) => ({
    lat: place.lat,
    lng: place.lng,
    radiusM: FREQUENT_PLACE_RULES[place.category].radiusM,
  }));
}

// ---------------------------------------------------------------------------
// From fixes to a visit
// ---------------------------------------------------------------------------

/** An open stay, as the server remembers it between two fixes. */
export interface Presence {
  placeId: string;
  category: FrequentPlaceCategory;
  /** Server-clock instants (ms) of the first and the latest fix at the place. */
  firstAt: number;
  lastAt: number;
  /** The local day this stay already wrote, so a long stay writes once. */
  creditedDay: string | null;
}

export interface PresenceStep {
  presence: Presence | null;
  /** Set when this fix completed a visit that has not been written yet. */
  visit: { placeId: string; day: string } | null;
}

/** The longest silence one stay at a place of this category survives. */
export function maxGapMs(category: FrequentPlaceCategory): number {
  return FREQUENT_PLACE_RULES[category].maxGapMinutes * MINUTE_MS;
}

/**
 * Advance one person's stay by one reading.
 *
 * A single fix never makes a visit: the first fix at a place only OPENS a
 * stay, and the visit is written when a later fix at the same place lands at
 * least {@link FREQUENT_PLACE_MIN_DWELL_MINUTES} after the first, with no
 * `away` reading between them and no silence longer than the category allows.
 *
 * The silence bound is what the absence of background tracking costs. Between
 * two fixes the app was closed and nothing is known; ninety minutes at one café
 * is still believable as one stay, while a fix at 9:00 and another at 18:00 are
 * two walks past the door. A fix at or before the latest one already counted —
 * a retry, or a cached position sent twice — changes nothing.
 */
export function stepPresence(
  presence: Presence | null,
  reading: FixReading,
  at: number,
  dayOf: (at: number) => string,
): PresenceStep {
  if (presence && at <= presence.lastAt) return { presence, visit: null };

  const live =
    presence && at - presence.lastAt <= maxGapMs(presence.category) ? presence : null;

  if (reading.kind === "away") return { presence: null, visit: null };
  if (reading.kind === "unclear") return { presence: live, visit: null };

  const next: Presence =
    live && live.placeId === reading.placeId
      ? { ...live, lastAt: at }
      : {
          placeId: reading.placeId,
          category: reading.category,
          firstAt: at,
          lastAt: at,
          creditedDay: null,
        };

  if (next.lastAt - next.firstAt < FREQUENT_PLACE_MIN_DWELL_MINUTES * MINUTE_MS) {
    return { presence: next, visit: null };
  }
  const day = dayOf(at);
  if (next.creditedDay === day) return { presence: next, visit: null };
  return {
    presence: { ...next, creditedDay: day },
    visit: { placeId: next.placeId, day },
  };
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** The calendar day (`YYYY-MM-DD`) an instant falls on in `timeZone`. */
export function localDay(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Whole days from `day` to `today`; negative when `day` is the later one. */
export function daysBetween(day: string, today: string): number {
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS,
  );
}

/** `day` moved by `delta` whole days. */
export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// From visits to the profile
// ---------------------------------------------------------------------------

/** One day on which a person was at a place, from either source. */
export interface VisitDay {
  placeId: string;
  day: string;
}

export interface FrequentPlace {
  placeId: string;
  name: string;
  category: FrequentPlaceCategory;
  /** Distinct days with a visit inside the window. Shown to the owner only. */
  visits: number;
  hidden: boolean;
}

export interface FrequentPlaceRanking {
  /** What the profile and the match see, best first. */
  shown: FrequentPlace[];
  /** Qualifying places their owner hid, best first — the owner's list only. */
  hidden: FrequentPlace[];
}

/**
 * A qualifying place's score:
 *
 *   S = weight(category) · Σ 2^(−age_days / half-life) / threshold(category)
 *
 * Dividing by the threshold puts categories on one scale — a museum at its 3
 * visits and a café at its 5 both read as 1 × weight — and the weight then
 * breaks the tie toward the less routine category, which is the brief's
 * "lower bar, higher significance". The decay makes a café visited weekly this
 * month outrank one visited just as often in the spring.
 */
export function frequentPlaceScore(
  category: FrequentPlaceCategory,
  days: Iterable<string>,
  today: string,
): number {
  const rule = FREQUENT_PLACE_RULES[category];
  let decayed = 0;
  for (const day of days) {
    const age = Math.max(0, daysBetween(day, today));
    decayed += 2 ** (-age / FREQUENT_PLACE_HALF_LIFE_DAYS);
  }
  return (rule.weight * decayed) / rule.minVisits;
}

interface Scored {
  place: FrequentPlace;
  score: number;
  lastDay: string;
}

function compareScored(a: Scored, b: Scored): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.lastDay !== b.lastDay) return a.lastDay < b.lastDay ? 1 : -1;
  if (a.place.placeId === b.place.placeId) return 0;
  return a.place.placeId < b.place.placeId ? -1 : 1;
}

/**
 * The places a profile shows, and the ones its owner hid.
 *
 * A visit counts toward a threshold when it is inside the window, and a place
 * counts at all only when it is still an active catalog place of a recognised
 * category — a date at a Places-fallback venue, or a café the catalog retired,
 * never reaches a profile. Hiding happens BEFORE the limit, so hiding one place
 * promotes the next rather than leaving a gap; the category cap keeps three
 * coffee shops from being the whole block.
 */
export function rankFrequentPlaces(input: {
  visits: readonly VisitDay[];
  places: ReadonlyMap<string, CatalogPlace>;
  hidden: ReadonlySet<string>;
  today: string;
}): FrequentPlaceRanking {
  const daysByPlace = new Map<string, Set<string>>();
  for (const visit of input.visits) {
    const age = daysBetween(visit.day, input.today);
    if (age < 0 || age >= FREQUENT_PLACE_WINDOW_DAYS) continue;
    const days = daysByPlace.get(visit.placeId) ?? new Set<string>();
    days.add(visit.day);
    daysByPlace.set(visit.placeId, days);
  }

  const qualifying: Scored[] = [];
  for (const [placeId, days] of daysByPlace) {
    const catalogPlace = input.places.get(placeId);
    if (!catalogPlace) continue;
    if (days.size < FREQUENT_PLACE_RULES[catalogPlace.category].minVisits) continue;
    let lastDay = "";
    for (const day of days) if (day > lastDay) lastDay = day;
    qualifying.push({
      place: {
        placeId,
        name: catalogPlace.name,
        category: catalogPlace.category,
        visits: days.size,
        hidden: input.hidden.has(placeId),
      },
      score: frequentPlaceScore(catalogPlace.category, days, input.today),
      lastDay,
    });
  }
  qualifying.sort(compareScored);

  const shown: FrequentPlace[] = [];
  const hidden: FrequentPlace[] = [];
  const perCategory = new Map<FrequentPlaceCategory, number>();
  for (const { place } of qualifying) {
    if (place.hidden) {
      hidden.push(place);
      continue;
    }
    if (shown.length >= FREQUENT_PLACE_PROFILE_LIMIT) continue;
    const taken = perCategory.get(place.category) ?? 0;
    if (taken >= FREQUENT_PLACE_PER_CATEGORY_LIMIT) continue;
    perCategory.set(place.category, taken + 1);
    shown.push(place);
  }
  return { shown, hidden };
}
