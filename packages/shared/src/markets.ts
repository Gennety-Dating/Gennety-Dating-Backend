/**
 * Supported markets — the cities Gennety actually operates in.
 *
 * Matching is strictly same-city (`buildCandidateSql` joins on an exact
 * `Profile.homeCityKey` equality), so a user who registers with a city we have
 * not launched lands in a pool of one. Until 2026-07 registration accepted any
 * city Google Places could name, which created those isolated pools and
 * promised a service that does not exist there yet.
 *
 * This list is the single source of truth for every surface (Telegram Mini App,
 * bot, public `/v1/*` API consumed by the native iOS client). Launching a new
 * city is deliberately a code change rather than an env flag: a market is only
 * real once its curated venue catalog (`curated_venues.cityKey`), ad campaign,
 * and ops processes exist, and those already ship as code/scripts. Adding an
 * entry here without them would recreate exactly the problem this module fixes.
 *
 * Adding a market:
 *   1. seed + review its `curated_venues` rows (scripts/seed-venues.mjs)
 *   2. add the entry below (cityKey must match the venue rows' `cityKey`)
 *   3. confirm the timezone resolves (packages/shared/src/timezone.ts)
 */

export interface Market {
  /** Canonical `<country>:<slug>` key — identical to `Profile.homeCityKey`. */
  cityKey: string;
  /** Canonical display name. Client-supplied names are replaced by this. */
  city: string;
  /** ISO-3166 alpha-2, upper-case. */
  countryCode: string;
  /** City centroid. Also the canonical `Profile.latitude/longitude`. */
  latitude: number;
  longitude: number;
  /**
   * Radius (km) around the centroid treated as "inside this market".
   *
   * NOT just a geolocation hint, whatever an older version of this comment
   * said. Four things read it, and two of them are hard gates:
   *   - `marketForCoordinates` — pre-selecting the city from geolocation
   *     (a false negative is cheap: the user taps the city themselves);
   *   - `checkDepartureOrigin` — the departure-point gate, which REFUSES a
   *     pin outside it (PRODUCT_SPEC §3.7);
   *   - `marketBoundingBox` — the box Google Places search is restricted to;
   *   - the venue geo ladder's widest rung (`venue-intent-v2.ts`).
   *
   * Sized to the CITY, not to the commuter belt (founder decision
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

const KYIV: Market = {
  cityKey: "ua:kyiv",
  city: "Kyiv",
  countryCode: "UA",
  latitude: 50.4501,
  longitude: 30.5234,
  radiusKm: 21,
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

/** Every market Gennety is live in. Order is display order. */
export const SUPPORTED_MARKETS: readonly Market[] = [KYIV];

/**
 * The market we point everyone at while the list holds exactly one entry
 * (the "switch to Kyiv" offer for legacy accounts registered elsewhere).
 */
export const DEFAULT_MARKET: Market = KYIV;

/** All supported `homeCityKey` values, for logging/analytics call sites. */
export const SUPPORTED_CITY_KEYS: readonly string[] = SUPPORTED_MARKETS.map(
  (market) => market.cityKey,
);

export function findMarketByCityKey(cityKey: string | null | undefined): Market | null {
  const key = cityKey?.trim().toLowerCase();
  if (!key) return null;
  return SUPPORTED_MARKETS.find((market) => market.cityKey === key) ?? null;
}

/** True when this city is a launched market (i.e. matching can actually work). */
export function isSupportedCityKey(cityKey: string | null | undefined): boolean {
  return findMarketByCityKey(cityKey) !== null;
}

/**
 * Free-text city search. Replaces the old Google Places lookup: with a curated
 * market set a global geocoder can only ever propose cities we must refuse.
 */
export function searchMarkets(query: string): Market[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SUPPORTED_MARKETS];
  return SUPPORTED_MARKETS.filter(
    (market) =>
      market.city.toLowerCase().includes(q) ||
      market.aliases.some((alias) => alias.includes(q) || q.includes(alias)),
  );
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

/**
 * Which market a pair of coordinates falls into, or `null` when the user is
 * outside every launched city. `null` is the honest answer the onboarding
 * geolocation step needs — it must never silently resolve to a market the
 * person is not in.
 */
export function marketForCoordinates(latitude: number, longitude: number): Market | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  let best: Market | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const market of SUPPORTED_MARKETS) {
    const distance = distanceKm(latitude, longitude, market.latitude, market.longitude);
    if (distance <= market.radiusKm && distance < bestDistance) {
      best = market;
      bestDistance = distance;
    }
  }
  return best;
}
