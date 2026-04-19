/**
 * Geographic utilities for the concierge venue flow (Phase 3.4).
 *
 * Pure functions, zero dependencies. All math is done on a unit sphere via
 * Cartesian conversion so the midpoint is the true great-circle midpoint
 * (not the naive lat/lng average, which is wrong near the date line and
 * at high latitudes).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Great-circle midpoint of two geographic points.
 *
 * Converts both to 3D Cartesian on a unit sphere, averages the components,
 * then converts back to lat/lng. This is correct everywhere, including
 * across the antimeridian and at high latitudes where the naive formula
 * `((aLat+bLat)/2, (aLng+bLng)/2)` produces wrong results.
 *
 * When the two points are (numerically) identical, returns the input point
 * verbatim instead of running through the Cartesian path — avoids
 * floating-point drift on the no-op case (useful for same-campus matches).
 */
export function midpoint(a: LatLng, b: LatLng): LatLng {
  if (a.lat === b.lat && a.lng === b.lng) {
    return { lat: a.lat, lng: a.lng };
  }

  const latA = toRad(a.lat);
  const lngA = toRad(a.lng);
  const latB = toRad(b.lat);
  const lngB = toRad(b.lng);

  const xA = Math.cos(latA) * Math.cos(lngA);
  const yA = Math.cos(latA) * Math.sin(lngA);
  const zA = Math.sin(latA);

  const xB = Math.cos(latB) * Math.cos(lngB);
  const yB = Math.cos(latB) * Math.sin(lngB);
  const zB = Math.sin(latB);

  const x = (xA + xB) / 2;
  const y = (yA + yB) / 2;
  const z = (zA + zB) / 2;

  const lng = Math.atan2(y, x);
  const hyp = Math.sqrt(x * x + y * y);
  const lat = Math.atan2(z, hyp);

  return { lat: toDeg(lat), lng: toDeg(lng) };
}

/**
 * Great-circle distance between two points in kilometres (Haversine).
 * Used to derive a sensible Places search radius from the pair's spread.
 */
export function haversineDistanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const latA = toRad(a.lat);
  const latB = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Pick a Places search radius (metres) for a pair whose commute origins are
 * `distanceKm` apart. Policy:
 *   - floor at 500m (both users in the same block → still give the search
 *     room to find >1 option),
 *   - cap at 5km (larger radii are transit-unfriendly — students don't own
 *     cars; we'd rather pitch a central spot in the walkable neighbourhood
 *     around the midpoint than a distant-but-equidistant venue),
 *   - otherwise ~30% of the spread, since the midpoint is already the
 *     barycentre and we just need enough coverage to find >5 candidates.
 */
export function venueSearchRadiusMeters(distanceKm: number): number {
  const MIN_M = 500;
  const MAX_M = 5000;
  const radius = Math.round(distanceKm * 1000 * 0.3);
  return Math.max(MIN_M, Math.min(MAX_M, radius));
}
