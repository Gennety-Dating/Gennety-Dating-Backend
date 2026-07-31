/**
 * Forecast lookup for venue ranking (VENUE_ENGINE_IMPROVEMENT_PLAN 5.3).
 *
 * Open-Meteo: no API key, no account, no quota to manage. Chosen for exactly
 * that reason — the value this adds is a few positions of reordering among
 * near-equal venues, which does not justify a credentialed dependency.
 *
 * Two properties are load-bearing and everything else follows from them:
 *
 *   1. **It cannot block a date.** Every failure path — network, timeout,
 *      non-200, unparseable body, a date outside the forecast horizon —
 *      returns `null`, and `null` scores exactly like perfect weather in
 *      `weatherRelevanceMultiplier`. An outage must never be able to withhold
 *      the outdoor half of the catalog.
 *   2. **One lookup per selection run, not per candidate.** Every candidate in
 *      a run sits in one city at one hour, so their forecasts are identical at
 *      the precision this needs. The in-memory cache then collapses runs
 *      across pairs too.
 */

import { env } from "../config.js";
import type { VenueWeatherSnapshot } from "@gennety/shared";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/**
 * WMO weather codes that make an outdoor date a bad idea regardless of the
 * precipitation probability: thunderstorms (95-99), freezing rain (66-67),
 * heavy snow (75, 85-86), and hail. Drizzle and light rain are deliberately
 * absent — they are handled by the probability threshold, and treating them
 * categorically would sink half the catalog on an ordinary damp day.
 */
const SEVERE_WMO_CODES = new Set([66, 67, 75, 82, 85, 86, 95, 96, 99]);

/** Open-Meteo publishes ~16 days; past that the API returns nothing useful. */
const FORECAST_HORIZON_DAYS = 16;

interface CacheEntry {
  value: VenueWeatherSnapshot | null;
  expiresAt: number;
}

// Per-process, resets on restart — the same shape as `usage-limiter`. A cold
// cache costs one HTTP call, so persistence would buy nothing.
const cache = new Map<string, CacheEntry>();

/** Test seam: the cache would otherwise leak state between cases. */
export function __resetWeatherCacheForTests(): void {
  cache.clear();
}

/** ~28 km of latitude — the coordinate fallback when no city scope is given. */
const CACHE_GRID = 4;

/**
 * Two pairs meeting in the same city within the same hour must share one entry,
 * or the cache does nothing at the volume that matters. The city key does that
 * exactly; the coordinate grid is the fallback for a pair whose profiles carry
 * no `homeCityKey`.
 *
 * The grid FLOORS rather than rounds. `toFixed` rounds to nearest, which puts
 * two origins a kilometre apart into different buckets whenever they straddle a
 * rounding boundary (50.44 → 50.4, 50.45 → 50.5) — the opposite of bucketing.
 *
 * Collapsing a whole market to one forecast is deliberate: a launched market is
 * at most a 60 km radius (§1.3), which is one weather system at the precision
 * "will it rain during the date" needs.
 */
function cacheKey(lat: number, lng: number, at: Date, scope: string | null): string {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  const place = scope
    ? scope
    : `${Math.floor(lat * CACHE_GRID) / CACHE_GRID}:${Math.floor(lng * CACHE_GRID) / CACHE_GRID}`;
  return `${place}:${hour.toISOString()}`;
}

/** Open-Meteo indexes hourly arrays by a naive local-time ISO string. */
function hourIndexKey(at: Date, utcOffsetSeconds: number): string {
  const local = new Date(at.getTime() + utcOffsetSeconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:00`;
}

interface OpenMeteoResponse {
  utc_offset_seconds?: number;
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    weather_code?: (number | null)[];
  };
}

/**
 * Fetch the forecast for one place and hour. Returns null whenever the answer
 * is not confidently known — the caller treats that as "no opinion".
 *
 * @param scope Cache scope, normally the pair's `homeCityKey`. Only groups
 *   cache entries; the request itself always uses the exact coordinates.
 */
export async function fetchWeatherForecast(
  lat: number,
  lng: number,
  at: Date,
  scope: string | null = null,
): Promise<VenueWeatherSnapshot | null> {
  if (!env.VENUE_SEASON_WEATHER_ENABLED) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(at.getTime())) return null;

  // Outside the published horizon there is nothing to ask for. Checked before
  // the cache so a far-future date never occupies an entry.
  const daysAhead = (at.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (daysAhead > FORECAST_HORIZON_DAYS) return null;

  const key = cacheKey(lat, lng, at, scope);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = await requestForecast(lat, lng, at);
  // A failed lookup is cached too, for the same TTL: without that, a provider
  // outage turns into one outbound request per candidate selection, which is
  // precisely when we least want to be hammering a service that is down.
  cache.set(key, { value, expiresAt: Date.now() + env.VENUE_WEATHER_CACHE_TTL_MS });
  return value;
}

async function requestForecast(
  lat: number,
  lng: number,
  at: Date,
): Promise<VenueWeatherSnapshot | null> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lng.toFixed(4));
  url.searchParams.set("hourly", "temperature_2m,precipitation_probability,weather_code");
  url.searchParams.set("forecast_days", String(FORECAST_HORIZON_DAYS));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.VENUE_WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as OpenMeteoResponse;

    const times = body.hourly?.time;
    if (!Array.isArray(times)) return null;
    const index = times.indexOf(hourIndexKey(at, body.utc_offset_seconds ?? 0));
    if (index < 0) return null;

    const temperatureC = body.hourly?.temperature_2m?.[index];
    if (typeof temperatureC !== "number") return null;
    const precipitation = body.hourly?.precipitation_probability?.[index];
    const code = body.hourly?.weather_code?.[index];

    return {
      temperatureC,
      // Open-Meteo omits precipitation probability for some models. Absent is
      // not "0% chance of rain" — but it is also not a reason to discard a
      // usable temperature reading, so it reads as dry and lets the
      // temperature and severity signals stand on their own.
      precipitationProbabilityPct: typeof precipitation === "number" ? precipitation : 0,
      isSevere: typeof code === "number" && SEVERE_WMO_CODES.has(code),
    };
  } catch {
    // Abort, DNS failure, malformed JSON — all one outcome by design.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
