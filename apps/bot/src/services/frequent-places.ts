/**
 * Frequently visited places — the stateful half (docs/product/domains/
 * frequent-places.md). `frequent-places-rules.ts` decides; this file loads the
 * catalog, remembers open stays, writes visits and reads them back.
 *
 * ── What is kept, and where ─────────────────────────────────────────────
 *
 * - The city's catalog, in memory for ten minutes — the showcase's trade: it
 *   changes by an operator import or the nightly re-validation, never by the
 *   minute, and every fix in a city asks about the same ~270 places.
 * - One open stay per person, in memory only: which place, and the first and
 *   latest instant. Never a coordinate — a fix is read against the catalog and
 *   dropped, the rule the Date Radar and the Scratch Map already follow. A
 *   restart loses at most the stay in progress, and the next fix opens a new
 *   one; that is the same single-process trade `date-radar.ts` names, correct
 *   while the bot runs as one PM2 process.
 * - A visit: one `user_place_visits` row, a place id and a local day.
 *
 * A date the person attended is a visit too, and it is read from `Match` when
 * the list is built rather than copied into the log: attendance already has
 * one home, and a copy would have to follow every later correction of it.
 */
import { prisma } from "@gennety/db";
import {
  DEFAULT_MARKET,
  FREQUENT_PLACE_CATEGORIES,
  FREQUENT_PLACE_FIX_MAX_AGE_SECONDS,
  FREQUENT_PLACE_MAX_ACCURACY_M,
  FREQUENT_PLACE_PROBE_INTERVAL_SECONDS,
  FREQUENT_PLACE_WINDOW_DAYS,
  cityKeyToTimeZone,
  findMarketByCityKey,
  isFrequentPlaceCategory,
  type FrequentPlaceCategory,
} from "@gennety/shared";

import {
  fencesFor,
  localDay,
  rankFrequentPlaces,
  readFix,
  shiftDay,
  stepPresence,
  type CatalogPlace,
  type Fence,
  type Fix,
  type FrequentPlaceRanking,
  type Presence,
  type VisitDay,
} from "./frequent-places-rules.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** How long one city's catalog is served from memory (the showcase's number). */
export const FREQUENT_PLACE_CATALOG_TTL_MS = 10 * MINUTE_MS;

/**
 * How long a person's shown places are served to their match from memory.
 * `/v1/matches/current` is polled; the list moves at most once a day per place.
 * Every write that could change it (a visit, a hide, the toggle) drops the
 * entry, so the TTL only bounds what a restart-free process would otherwise
 * keep forever.
 */
export const PARTNER_PLACES_TTL_MS = 10 * MINUTE_MS;

/** Bounds on the three in-memory maps, against junk keys or a flood of accounts. */
const CATALOG_MAX_CITIES = 32;
const PRESENCE_MAX_USERS = 50_000;
const PARTNER_CACHE_MAX_USERS = 5_000;

const CATEGORY_FILTER: string[] = [...FREQUENT_PLACE_CATEGORIES];

const CATALOG_SELECT = {
  id: true,
  placeId: true,
  name: true,
  category: true,
  priority: true,
  lat: true,
  lng: true,
} as const;

/** The catalog columns this feature reads. */
export interface CatalogRow {
  id: string;
  placeId: string | null;
  name: string;
  category: string;
  priority: number;
  lat: number;
  lng: number;
}

/**
 * Catalog rows → one place per Google place id.
 *
 * The row that names a place is the operator's best copy (lowest `priority`,
 * then id), so a place is always called the same thing whichever domain's row
 * a query happens to meet first. A row without a place id is skipped: without
 * the identity every other reader dedupes on, two copies of one café would be
 * two places and a visit could land on either.
 *
 * The product's "never offer" rules (`museum`, blocked names) are NOT applied:
 * they say what we propose for a first date, and this block says where a
 * person goes on their own.
 */
export function toCatalogPlaces(rows: readonly CatalogRow[]): CatalogPlace[] {
  const ordered = [...rows].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const byPlace = new Map<string, CatalogPlace>();
  for (const row of ordered) {
    if (!row.placeId || byPlace.has(row.placeId)) continue;
    if (!isFrequentPlaceCategory(row.category)) continue;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    byPlace.set(row.placeId, {
      placeId: row.placeId,
      name: row.name,
      category: row.category,
      lat: row.lat,
      lng: row.lng,
    });
  }
  return [...byPlace.values()];
}

/** Insert as the newest entry, dropping the oldest while over `max`. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function dateToDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const catalogCache = new Map<string, { at: number; places: CatalogPlace[] }>();

/** Every recognisable place of one city. `now` is for tests. */
export async function catalogForCity(
  cityKey: string,
  now: number = Date.now(),
): Promise<CatalogPlace[]> {
  const cached = catalogCache.get(cityKey);
  if (cached && now - cached.at < FREQUENT_PLACE_CATALOG_TTL_MS) return cached.places;

  const rows = await prisma.curatedVenue.findMany({
    where: { cityKey, active: true, category: { in: CATEGORY_FILTER } },
    select: CATALOG_SELECT,
  });
  const places = toCatalogPlaces(rows);
  remember(catalogCache, cityKey, { at: now, places }, CATALOG_MAX_CITIES);
  return places;
}

/**
 * The active catalog places behind a set of place ids, in any city: a visit
 * from before a move, or a date in another city, still names its place.
 */
async function catalogByPlaceIds(placeIds: readonly string[]): Promise<Map<string, CatalogPlace>> {
  if (placeIds.length === 0) return new Map();
  const rows = await prisma.curatedVenue.findMany({
    where: { placeId: { in: [...placeIds] }, active: true, category: { in: CATEGORY_FILTER } },
    select: CATALOG_SELECT,
  });
  return new Map(toCatalogPlaces(rows).map((place) => [place.placeId, place]));
}

interface Subject {
  optIn: boolean;
  cityKey: string;
  timeZone: string;
}

async function subjectFor(userId: string): Promise<Subject | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { frequentPlacesOptIn: true, profile: { select: { homeCityKey: true } } },
  });
  if (!user) return null;
  // The Scratch Map's fallback: a person without a city belongs to the default
  // market, which is where the product is.
  const market = findMarketByCityKey(user.profile?.homeCityKey) ?? DEFAULT_MARKET;
  return {
    optIn: user.frequentPlacesOptIn,
    cityKey: market.cityKey,
    timeZone: cityKeyToTimeZone(market.cityKey),
  };
}

// ---------------------------------------------------------------------------
// The client's half: fences and fixes
// ---------------------------------------------------------------------------

/** The numbers a client runs on, handed over rather than compiled in. */
export interface FencePolicy {
  maxAccuracyM: number;
  fixMaxAgeSeconds: number;
  probeIntervalSeconds: number;
}

export interface FencesPayload {
  optIn: boolean;
  cityKey: string | null;
  policy: FencePolicy;
  fences: Fence[];
}

const POLICY: FencePolicy = {
  maxAccuracyM: FREQUENT_PLACE_MAX_ACCURACY_M,
  fixMaxAgeSeconds: FREQUENT_PLACE_FIX_MAX_AGE_SECONDS,
  probeIntervalSeconds: FREQUENT_PLACE_PROBE_INTERVAL_SECONDS,
};

/**
 * The caller's city as circles. Empty while switched off — a client with no
 * fences has nothing to compare a fix against and so sends nothing, which is
 * how the toggle reaches the phone without a second rule on the client.
 */
export async function fencesForUser(userId: string): Promise<FencesPayload> {
  const subject = await subjectFor(userId);
  if (!subject?.optIn) {
    return { optIn: false, cityKey: subject?.cityKey ?? null, policy: POLICY, fences: [] };
  }
  const places = await catalogForCity(subject.cityKey);
  return { optIn: true, cityKey: subject.cityKey, policy: POLICY, fences: fencesFor(places) };
}

/** One report from a foreground client. */
export type PresenceReport =
  | { kind: "fix"; fix: Fix; ageSeconds: number }
  | { kind: "away" };

export type PresenceRefusal = "opted-out";

const presences = new Map<string, Presence>();

/**
 * Fold one report into the person's open stay, writing a visit when the stay
 * has just become one.
 *
 * The instant of a fix is the SERVER's clock minus the age the phone measured,
 * so a device with a wrong date can neither stretch a stay nor shorten it, and
 * a cached position sent again is refused by its own growing age.
 */
export async function recordPresence(input: {
  userId: string;
  report: PresenceReport;
  now?: number;
}): Promise<{ recorded: boolean } | { refused: PresenceRefusal }> {
  const now = input.now ?? Date.now();
  const subject = await subjectFor(input.userId);
  if (!subject?.optIn) {
    presences.delete(input.userId);
    return { refused: "opted-out" };
  }

  if (input.report.kind === "away") {
    presences.delete(input.userId);
    return { recorded: false };
  }

  const { fix, ageSeconds } = input.report;
  if (!(ageSeconds >= 0 && ageSeconds <= FREQUENT_PLACE_FIX_MAX_AGE_SECONDS)) {
    return { recorded: false };
  }

  const places = await catalogForCity(subject.cityKey);
  const step = stepPresence(
    presences.get(input.userId) ?? null,
    readFix(fix, places),
    now - ageSeconds * 1000,
    (at) => localDay(at, subject.timeZone),
  );
  if (step.presence) remember(presences, input.userId, step.presence, PRESENCE_MAX_USERS);
  else presences.delete(input.userId);

  if (!step.visit) return { recorded: false };

  // `skipDuplicates` is the ON CONFLICT DO NOTHING the unique key is for: the
  // same stay reported twice, or two app processes racing, is still one day.
  await prisma.userPlaceVisit.createMany({
    data: [
      {
        userId: input.userId,
        placeId: step.visit.placeId,
        visitDay: dayToDate(step.visit.day),
      },
    ],
    skipDuplicates: true,
  });
  partnerCache.delete(input.userId);
  return { recorded: true };
}

// ---------------------------------------------------------------------------
// Reading the list
// ---------------------------------------------------------------------------

export interface FrequentPlacesView {
  optIn: boolean;
  ranking: FrequentPlaceRanking;
}

/**
 * The person's ranked places. Switched off, there is nothing to show — to the
 * owner as much as to the match — and nothing is read.
 */
export async function readFrequentPlaces(
  userId: string,
  now: number = Date.now(),
): Promise<FrequentPlacesView> {
  const subject = await subjectFor(userId);
  if (!subject?.optIn) return { optIn: false, ranking: { shown: [], hidden: [] } };

  const today = localDay(now, subject.timeZone);
  const firstDay = shiftDay(today, -(FREQUENT_PLACE_WINDOW_DAYS - 1));

  const [rows, dates, hiddenRows] = await Promise.all([
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
        // A day of slack: `agreedTime` is an instant and the window is made of
        // local days. The ranking applies the exact window.
        agreedTime: { gte: new Date(dayToDate(firstDay).getTime() - DAY_MS) },
      },
      select: { venuePlaceId: true, agreedTime: true },
    }),
    prisma.userHiddenPlace.findMany({ where: { userId }, select: { placeId: true } }),
  ]);

  const visits: VisitDay[] = rows.map((row) => ({
    placeId: row.placeId,
    day: dateToDay(row.visitDay),
  }));
  for (const date of dates) {
    if (!date.venuePlaceId || !date.agreedTime) continue;
    visits.push({
      placeId: date.venuePlaceId,
      day: localDay(date.agreedTime.getTime(), subject.timeZone),
    });
  }

  const places = await catalogByPlaceIds([...new Set(visits.map((v) => v.placeId))]);
  return {
    optIn: true,
    ranking: rankFrequentPlaces({
      visits,
      places,
      hidden: new Set(hiddenRows.map((row) => row.placeId)),
      today,
    }),
  };
}

/** One place as the match sees it. */
export interface PartnerPlace {
  placeId: string;
  name: string;
  category: FrequentPlaceCategory;
}

const partnerCache = new Map<string, { at: number; places: PartnerPlace[] }>();

/**
 * What a match sees of this person's places: the shown ranking, reduced to a
 * name and a category. No visit count, no day, no position — the Date Radar's
 * rule that the shape of the answer IS the privacy. This is the one function
 * that decides what crosses to the other person, so nothing else may build
 * that list.
 */
export async function partnerFrequentPlaces(
  userId: string,
  now: number = Date.now(),
): Promise<PartnerPlace[]> {
  const cached = partnerCache.get(userId);
  if (cached && now - cached.at < PARTNER_PLACES_TTL_MS) return cached.places;

  const { optIn, ranking } = await readFrequentPlaces(userId, now);
  const places: PartnerPlace[] = optIn
    ? ranking.shown.map(({ placeId, name, category }) => ({ placeId, name, category }))
    : [];
  remember(partnerCache, userId, { at: now, places }, PARTNER_CACHE_MAX_USERS);
  return places;
}

// ---------------------------------------------------------------------------
// The owner's controls
// ---------------------------------------------------------------------------

/**
 * The toggle. Off stops collection at once (the open stay is dropped, fences
 * go empty) and removes the block from the owner and the match; the stored
 * days stay and age out with the window, the Scratch Map's rule for a toggle.
 */
export async function setFrequentPlacesOptIn(userId: string, enabled: boolean): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { frequentPlacesOptIn: enabled },
  });
  if (!enabled) presences.delete(userId);
  partnerCache.delete(userId);
}

/** Google place ids are letters, digits, `_` and `-`; anything else is not one. */
export function isPlaceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,255}$/.test(value);
}

export async function setPlaceHidden(
  userId: string,
  placeId: string,
  hidden: boolean,
): Promise<void> {
  if (hidden) {
    await prisma.userHiddenPlace.upsert({
      where: { userId_placeId: { userId, placeId } },
      create: { userId, placeId },
      update: {},
    });
  } else {
    await prisma.userHiddenPlace.deleteMany({ where: { userId, placeId } });
  }
  partnerCache.delete(userId);
}

/** Test-only: forget every cache and every open stay. */
export function resetFrequentPlacesState(): void {
  catalogCache.clear();
  presences.clear();
  partnerCache.clear();
}
