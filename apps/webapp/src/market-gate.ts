/**
 * Client half of the departure-point gate (PRODUCT_SPEC §3.7).
 *
 * The server refuses an out-of-market pin whatever the client does
 * (`services/venue-origin.ts`), but a refusal that only arrives after Confirm
 * is a bad screen: the user has already committed, and the Mini App closes on
 * success, so the failure reads as the app breaking. This runs the same
 * geometry live as the map moves, so Confirm is simply unavailable while the
 * pin sits outside the city, with the reason next to it.
 *
 * Pure and DOM-free on purpose — the map wiring is hard to test, this is not.
 *
 * The market (centroid + radius) is served by `/v1/location/venue-intent/state`
 * rather than compiled in, so launching a second city needs no bundle redeploy.
 */

export interface MarketBounds {
  cityKey: string;
  city: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance in km. Mirrors `distanceKm` in
 * `packages/shared/src/markets.ts` — duplicated rather than imported because
 * `apps/webapp` deliberately does not depend on `@gennety/shared`, and the
 * server re-checks every pin anyway, so the two can never disagree about an
 * actual outcome.
 */
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
 * Is this pin inside the market? Permissive whenever we cannot tell — no
 * market on file, or coordinates that are not real numbers — so the client
 * never blocks Confirm over missing data. The server is the actual gate.
 */
export function isInsideMarket(
  market: MarketBounds | null,
  lat: number,
  lng: number,
): boolean {
  if (!market) return true;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
  return distanceKm(lat, lng, market.latitude, market.longitude) <= market.radiusKm;
}
