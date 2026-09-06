/**
 * The city catalog — every city the picker offers, and which of them Gennety
 * actually operates in.
 *
 * Matching is strictly same-city (`buildCandidateSql` joins on an exact
 * `Profile.homeCityKey` equality), so a user who registers with a city we have
 * not launched lands in a pool of one. Until 2026-07 registration accepted any
 * city Google Places could name, which created those isolated pools and
 * promised a service that does not exist there yet.
 *
 * The catalog therefore has two tiers, and the difference between them is a
 * hard product boundary, not a label:
 *
 *   - **`active`** — a launched market (`SUPPORTED_MARKETS`). Curated venues,
 *     ads and ops exist; `Profile.homeCityKey` may hold it; matching runs.
 *   - **`waitlist`** — a city we intend to open but have not (`WAITLIST_CITIES`).
 *     Registration records the demand (`city_waitlist_entries`) and stops there.
 *     A waitlist key MUST NEVER reach `Profile.homeCityKey`: that column is the
 *     matching boundary, and a second waitlisted person in the same city would
 *     otherwise be paired for a date in a city with no venue catalog.
 *     `validateHomeLocationPayload` is the single gate that enforces this.
 *
 * This module is the single source of truth for every surface (Telegram Mini
 * App, bot, public `/v1/*` API consumed by the native iOS client). Launching a
 * new city is deliberately a code change rather than an env flag: a market is
 * only real once its curated venue catalog (`curated_venues.cityKey`), ad
 * campaign, and ops processes exist, and those already ship as code/scripts.
 * Promoting an entry here without them would recreate exactly the problem this
 * module fixes.
 *
 * Promoting a waitlist city to a launched market:
 *   1. seed + review its `curated_venues` rows (scripts/seed-venues.mjs)
 *   2. move the entry from `WAITLIST_CITIES` to `SUPPORTED_MARKETS`, give it a
 *      measured `radiusKm` (see below) and `status: "active"`
 *   3. confirm the timezone resolves (packages/shared/src/timezone.ts)
 *   4. the people already waiting are `city_waitlist_entries` rows for that
 *      `cityKey` — the admin waitlist view is what tells you how many.
 */

/**
 * `active` = a launched market. `waitlist` = a city we record demand for and
 * nothing else. There is deliberately no third value: "partially open" is the
 * state that would let a waitlist key leak into matching.
 */
export type CityStatus = "active" | "waitlist";

interface CityBase {
  /** Canonical `<country>:<slug>` key — identical to `Profile.homeCityKey`. */
  cityKey: string;
  /** Canonical display name. Client-supplied names are replaced by this. */
  city: string;
  /** ISO-3166 alpha-2, upper-case. Also the picker's grouping key. */
  countryCode: string;
  /** City centroid. For a market, also the canonical `Profile.latitude/longitude`. */
  latitude: number;
  longitude: number;
  /**
   * Radius (km) around the centroid treated as "inside this city".
   *
   * **For a launched market this is NOT just a geolocation hint**, whatever an
   * older version of this comment said. Four things read it, and two of them
   * are hard gates:
   *   - `cityForCoordinates` / `marketForCoordinates` — pre-selecting the city
   *     from geolocation (a false negative is cheap: the user taps the city
   *     themselves);
   *   - `checkDepartureOrigin` — the departure-point gate, which REFUSES a
   *     pin outside it (PRODUCT_SPEC §3.7);
   *   - `marketBoundingBox` — the box Google Places search is restricted to;
   *   - the venue geo ladder's widest rung (`venue-intent-v2.ts`).
   *
   * For a **waitlist** city only the first of those can ever run — the other
   * three sit behind `Profile.homeCityKey`, which a waitlist city never
   * reaches — so its radius is a coarse pre-selection hint and nothing more
   * (`WAITLIST_CITY_RADIUS_KM`). Measure it properly when the city launches.
   *
   * Kyiv's is sized to the CITY, not to the commuter belt (founder decision
   * 2026-08-18): ads and acquisition target Kyiv proper, so a departure point
   * in the oblast is a person we cannot serve. It was 60 km until then, which
   * reached Boryspil and beyond.
   *
   * A circle cannot express a city boundary and 21 km is the honest
   * compromise, not a precise figure. Measured from this centroid, Vyshneve
   * (oblast) sits 12.8 km out while Pushcha-Vodytsia (Kyiv) sits 14.9 km out —
   * so no radius admits the whole city and excludes the near suburbs. 21 km
   * covers Kyiv down to ~50.26°N, i.e. everything but the forest-and-cottage
   * tail of Koncha-Zaspa at the oblast border, and still admits Vyshneve,
   * Vyshhorod, Brovary and Irpin. Excluding those would cost four real Kyiv
   * districts. The only exact answer is a boundary polygon.
   */
  radiusKm: number;
  /** Lower-case search aliases across the supported onboarding languages. */
  aliases: string[];
}

/**
 * A launched market. Same shape as any other catalog entry, discriminated on
 * `status` so a function that requires a real market (venue geo, the departure
 * gate, a `homeCityKey` write) cannot be handed a waitlist entry by accident —
 * the compiler refuses it rather than the reviewer having to notice.
 */
export interface Market extends CityBase {
  status: "active";
}

/** A city on the expansion list. Records demand; never a `homeCityKey`. */
export interface WaitlistCity extends CityBase {
  status: "waitlist";
}

/** Any catalog entry. A discriminated union — narrow it on `status`. */
export type City = Market | WaitlistCity;

/**
 * The radius every waitlist city carries. One shared, deliberately coarse
 * number rather than nineteen invented ones: for a waitlist city the radius
 * only ever pre-selects the picker's option from a geolocation fix, which the
 * user can override with one tap, and pretending to a per-city precision we
 * have not measured would be the kind of false exactness this file warns
 * about. A city gets a measured radius when it launches, not before.
 */
export const WAITLIST_CITY_RADIUS_KM = 25;

const KYIV: Market = {
  cityKey: "ua:kyiv",
  city: "Kyiv",
  countryCode: "UA",
  latitude: 50.4501,
  longitude: 30.5234,
  radiusKm: 21,
  status: "active",
  aliases: [
    "kyiv",
    "kiev",
    "kyev",
    "київ",
    "киев",
    "kijow",
    "kijów",
    "kiew",
    "ua:kyiv",
  ],
};

/** Shorthand for the waitlist rows below — they differ only in identity. */
function waitlistCity(
  cityKey: string,
  city: string,
  countryCode: string,
  latitude: number,
  longitude: number,
  aliases: string[],
): WaitlistCity {
  return {
    cityKey,
    city,
    countryCode,
    latitude,
    longitude,
    radiusKm: WAITLIST_CITY_RADIUS_KM,
    status: "waitlist",
    aliases: [cityKey, city.toLowerCase(), ...aliases],
  };
}

/**
 * Cities we take registrations of interest in and cannot serve yet.
 *
 * Order is display order inside each country, and countries are grouped in
 * `CITY_CATALOG` below. German cities are the fifteen largest by population,
 * which is the acquisition order the expansion plan follows.
 */
export const WAITLIST_CITIES: readonly WaitlistCity[] = [
  waitlistCity("ua:odesa", "Odesa", "UA", 46.4825, 30.7233, [
    "odessa", "одеса", "одесса", "odesa",
  ]),
  waitlistCity("ua:dnipro", "Dnipro", "UA", 48.4647, 35.0462, [
    "dnepr", "dnipropetrovsk", "дніпро", "днепр", "днепропетровск",
  ]),
  waitlistCity("ua:lviv", "Lviv", "UA", 49.8397, 24.0297, [
    "lvov", "lwow", "lwów", "lemberg", "львів", "львов",
  ]),
  waitlistCity("ua:kryvyi-rih", "Kryvyi Rih", "UA", 47.9105, 33.3918, [
    "krivoy rog", "krivoi rog", "kryvyj rih", "кривий ріг", "кривой рог",
  ]),
  waitlistCity("de:berlin", "Berlin", "DE", 52.52, 13.405, ["берлін", "берлин"]),
  waitlistCity("de:hamburg", "Hamburg", "DE", 53.5511, 9.9937, ["гамбург"]),
  waitlistCity("de:munich", "Munich", "DE", 48.1351, 11.582, [
    "münchen", "munchen", "muenchen", "monachium", "мюнхен",
  ]),
  waitlistCity("de:cologne", "Cologne", "DE", 50.9375, 6.9603, [
    "köln", "koln", "koeln", "kolonia", "кёльн", "кельн",
  ]),
  waitlistCity("de:frankfurt-am-main", "Frankfurt am Main", "DE", 50.1109, 8.6821, [
    "frankfurt", "франкфурт", "франкфурт-на-майні", "франкфурт-на-майне",
  ]),
  waitlistCity("de:stuttgart", "Stuttgart", "DE", 48.7758, 9.1829, ["штутгарт"]),
  waitlistCity("de:dusseldorf", "Düsseldorf", "DE", 51.2277, 6.7735, [
    "dusseldorf", "duesseldorf", "дюссельдорф",
  ]),
  waitlistCity("de:leipzig", "Leipzig", "DE", 51.3397, 12.3731, [
    "lipsk", "лейпциг", "ляйпциг",
  ]),
  waitlistCity("de:dortmund", "Dortmund", "DE", 51.5136, 7.4653, ["дортмунд"]),
  waitlistCity("de:essen", "Essen", "DE", 51.4556, 7.0116, ["ессен", "эссен"]),
  waitlistCity("de:bremen", "Bremen", "DE", 53.0793, 8.8017, ["бремен"]),
  waitlistCity("de:dresden", "Dresden", "DE", 51.0504, 13.7373, [
    "drezno", "дрезден",
  ]),
  waitlistCity("de:hannover", "Hanover", "DE", 52.3759, 9.732, [
    "hannover", "ганновер",
  ]),
  waitlistCity("de:nuremberg", "Nuremberg", "DE", 49.4521, 11.0767, [
    "nürnberg", "nurnberg", "nuernberg", "norymberga", "нюрнберг",
  ]),
  waitlistCity("de:duisburg", "Duisburg", "DE", 51.4344, 6.7623, ["дуйсбург"]),
];

/** Every market Gennety is live in. Order is display order. */
export const SUPPORTED_MARKETS: readonly Market[] = [KYIV];

/**
 * Every city the onboarding picker offers, launched ones first inside each
 * country, countries in expansion order. `status` is what the picker renders
 * as the "coming soon" chip and what `/city/select` branches on.
 */
export const CITY_CATALOG: readonly City[] = [...SUPPORTED_MARKETS, ...WAITLIST_CITIES];

/**
 * The market we point everyone at while the launched list holds exactly one
 * entry (the "switch to Kyiv" offer for legacy accounts registered elsewhere).
 */
export const DEFAULT_MARKET: Market = KYIV;

/** All supported `homeCityKey` values, for logging/analytics call sites. */
export const SUPPORTED_CITY_KEYS: readonly string[] = SUPPORTED_MARKETS.map(
  (market) => market.cityKey,
);

function normalizeCityKey(cityKey: string | null | undefined): string {
  return cityKey?.trim().toLowerCase() ?? "";
}

/** Any catalog entry — launched or waitlist — by key. */
export function findCityByKey(cityKey: string | null | undefined): City | null {
  const key = normalizeCityKey(cityKey);
  if (!key) return null;
  return CITY_CATALOG.find((city) => city.cityKey === key) ?? null;
}

export function findMarketByCityKey(cityKey: string | null | undefined): Market | null {
  const city = findCityByKey(cityKey);
  if (!city || city.status !== "active") return null;
  return city;
}

/** True when this city is a launched market (i.e. matching can actually work). */
export function isSupportedCityKey(cityKey: string | null | undefined): boolean {
  return findMarketByCityKey(cityKey) !== null;
}

/**
 * True when this city is in the catalog but not launched — the one input the
 * waitlist branch of `/city/select` is allowed to act on. A city that is not in
 * the catalog at all is false here: it is not a waitlist city, it is unknown,
 * and unknown input is refused rather than recorded as demand.
 */
export function isWaitlistCityKey(cityKey: string | null | undefined): boolean {
  return findCityByKey(cityKey)?.status === "waitlist";
}

function matchesQuery(city: City, q: string): boolean {
  return (
    city.city.toLowerCase().includes(q) ||
    city.aliases.some((alias) => alias.includes(q) || q.includes(alias))
  );
}

/**
 * Free-text search over launched markets only. Replaces the old Google Places
 * lookup: with a curated market set a global geocoder can only ever propose
 * cities we must refuse.
 */
export function searchMarkets(query: string): Market[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SUPPORTED_MARKETS];
  return SUPPORTED_MARKETS.filter((market) => matchesQuery(market, q));
}

/**
 * Free-text search over the whole catalog — what the onboarding picker uses,
 * because a city we have not launched is now an answer ("you're on the list")
 * rather than a dead end. Still first-party: a query that matches nothing here
 * matches no city this product knows about, and that is the honest result.
 */
export function searchCityCatalog(query: string): City[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CITY_CATALOG];
  return CITY_CATALOG.filter((city) => matchesQuery(city, q));
}

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in km (local copy — `packages/shared` has no geo util). */
export function distanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function nearestWithinRadius<T extends City>(
  cities: readonly T[],
  latitude: number,
  longitude: number,
): T | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const city of cities) {
    const distance = distanceKm(latitude, longitude, city.latitude, city.longitude);
    if (distance <= city.radiusKm && distance < bestDistance) {
      best = city;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Which market a pair of coordinates falls into, or `null` when the user is
 * outside every launched city. `null` is the honest answer every gate needs —
 * it must never silently resolve to a market the person is not in.
 */
export function marketForCoordinates(latitude: number, longitude: number): Market | null {
  return nearestWithinRadius(SUPPORTED_MARKETS, latitude, longitude);
}

/**
 * Which catalog city a pair of coordinates falls into, launched or not. Used by
 * the onboarding picker's "detect automatically" button, which now has
 * something to say to someone standing in Berlin. `null` still means "no city
 * this product knows about", and the caller must never invent one.
 */
export function cityForCoordinates(latitude: number, longitude: number): City | null {
  return nearestWithinRadius(CITY_CATALOG, latitude, longitude);
}
