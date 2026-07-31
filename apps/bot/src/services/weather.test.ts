import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = {
  VENUE_SEASON_WEATHER_ENABLED: true,
  VENUE_WEATHER_TIMEOUT_MS: 2500,
  VENUE_WEATHER_CACHE_TTL_MS: 3_600_000,
};
vi.mock("../config.js", () => ({ env: envMock }));

const { fetchWeatherForecast, __resetWeatherCacheForTests } = await import("./weather.js");

const NOW = new Date("2026-08-05T09:00:00.000Z");
/** Two hours out, comfortably inside the forecast horizon. */
const AT = new Date("2026-08-05T11:00:00.000Z");

/** Open-Meteo indexes hourly arrays by naive LOCAL time. */
function body(over: Record<string, unknown> = {}) {
  return {
    utc_offset_seconds: 10800, // Kyiv, so 11:00Z is 14:00 local
    hourly: {
      time: ["2026-08-05T13:00", "2026-08-05T14:00", "2026-08-05T15:00"],
      temperature_2m: [19, 21, 23],
      precipitation_probability: [5, 10, 15],
      weather_code: [0, 1, 2],
    },
    ...over,
  };
}

function mockFetch(impl: () => Promise<unknown>): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

function okResponse(payload: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetWeatherCacheForTests();
  envMock.VENUE_SEASON_WEATHER_ENABLED = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchWeatherForecast", () => {
  it("reads the hour matching the date in the venue's local time", async () => {
    mockFetch(() => okResponse(body()));
    const snapshot = await fetchWeatherForecast(50.45, 30.52, AT);
    expect(snapshot).toEqual({
      temperatureC: 21,
      precipitationProbabilityPct: 10,
      isSevere: false,
    });
  });

  it("flags severe weather codes", async () => {
    mockFetch(() => okResponse(body({
      hourly: {
        time: ["2026-08-05T14:00"],
        temperature_2m: [18],
        precipitation_probability: [80],
        weather_code: [95], // thunderstorm
      },
    })));
    const snapshot = await fetchWeatherForecast(50.45, 30.52, AT);
    expect(snapshot?.isSevere).toBe(true);
  });

  it("does not flag ordinary rain as severe", async () => {
    // Drizzle and light rain are handled by the probability threshold. Treating
    // them categorically would sink the outdoor catalog on a damp day.
    mockFetch(() => okResponse(body({
      hourly: {
        time: ["2026-08-05T14:00"],
        temperature_2m: [18],
        precipitation_probability: [60],
        weather_code: [61], // slight rain
      },
    })));
    const snapshot = await fetchWeatherForecast(50.45, 30.52, AT);
    expect(snapshot?.isSevere).toBe(false);
  });

  it("returns null and makes no request when the feature is off", async () => {
    envMock.VENUE_SEASON_WEATHER_ENABLED = false;
    const spy = vi.fn(() => okResponse(body()));
    vi.stubGlobal("fetch", spy);
    expect(await fetchWeatherForecast(50.45, 30.52, AT)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null past the published forecast horizon without calling out", async () => {
    const spy = vi.fn(() => okResponse(body()));
    vi.stubGlobal("fetch", spy);
    const farFuture = new Date(NOW.getTime() + 40 * 24 * 60 * 60 * 1000);
    expect(await fetchWeatherForecast(50.45, 30.52, farFuture)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["a network failure", () => Promise.reject(new Error("ECONNRESET"))],
    ["a non-200 response", () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })],
    ["an unparseable body", () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error("bad json")) })],
    ["a body with no hourly block", () => okResponse({ utc_offset_seconds: 0 })],
    ["an hour that is not in the response", () => okResponse(body({
      hourly: { time: ["2026-09-01T14:00"], temperature_2m: [20], precipitation_probability: [0], weather_code: [0] },
    }))],
    ["a null temperature at the matching hour", () => okResponse(body({
      hourly: { time: ["2026-08-05T14:00"], temperature_2m: [null], precipitation_probability: [0], weather_code: [0] },
    }))],
  ])("returns null on %s rather than throwing", async (_label, impl) => {
    // Every failure collapses to one outcome on purpose: the caller reads null
    // as "no opinion", which scores exactly like perfect weather. Anything
    // else would let an outage withhold venues.
    mockFetch(impl as () => Promise<unknown>);
    await expect(fetchWeatherForecast(50.45, 30.52, AT)).resolves.toBeNull();
  });

  it("treats a missing precipitation field as dry rather than discarding the reading", async () => {
    mockFetch(() => okResponse(body({
      hourly: { time: ["2026-08-05T14:00"], temperature_2m: [22], weather_code: [0] },
    })));
    const snapshot = await fetchWeatherForecast(50.45, 30.52, AT);
    expect(snapshot).toEqual({ temperatureC: 22, precipitationProbabilityPct: 0, isSevere: false });
  });

  it("serves every pair in the same city and hour from one entry", async () => {
    const spy = vi.fn(() => okResponse(body()));
    vi.stubGlobal("fetch", spy);
    // Opposite ends of Kyiv — different pairs, same market, same hour.
    await fetchWeatherForecast(50.21, 30.24, AT, "ua:kyiv");
    await fetchWeatherForecast(50.59, 30.83, AT, "ua:kyiv");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("buckets nearby origins together when no city scope is given", async () => {
    // Regression: the grid used `toFixed`, which ROUNDS — so 50.44 and 50.45,
    // barely a kilometre apart, landed in different buckets. A grid must floor.
    const spy = vi.fn(() => okResponse(body()));
    vi.stubGlobal("fetch", spy);
    await fetchWeatherForecast(50.44, 30.52, AT);
    await fetchWeatherForecast(50.45, 30.52, AT);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not share an entry across cities", async () => {
    const spy = vi.fn(() => okResponse(body()));
    vi.stubGlobal("fetch", spy);
    await fetchWeatherForecast(50.45, 30.52, AT, "ua:kyiv");
    await fetchWeatherForecast(49.84, 24.03, AT, "ua:lviv");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("caches failures too, so an outage is not amplified into a retry storm", async () => {
    const spy = vi.fn(() => Promise.reject(new Error("down")));
    vi.stubGlobal("fetch", spy);
    expect(await fetchWeatherForecast(50.45, 30.52, AT)).toBeNull();
    expect(await fetchWeatherForecast(50.45, 30.52, AT)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-requests once the cache entry expires", async () => {
    const spy = vi.fn(() => okResponse(body()));
    vi.stubGlobal("fetch", spy);
    await fetchWeatherForecast(50.45, 30.52, AT);
    vi.setSystemTime(new Date(NOW.getTime() + envMock.VENUE_WEATHER_CACHE_TTL_MS + 1000));
    await fetchWeatherForecast(50.45, 30.52, AT);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("evicts expired entries instead of growing without bound", async () => {
    // Expiry alone frees nothing — a stale entry stays in the Map, just unused.
    // Keys are `city:hour`, so without a sweep the set grows with every hour
    // ever asked about and never shrinks: slow, but unbounded in a process that
    // runs for months.
    const spy = vi.fn(() => okResponse(body()));
    vi.stubGlobal("fetch", spy);

    // Fill past the high-water mark with entries that then all expire.
    for (let i = 0; i < 600; i += 1) {
      await fetchWeatherForecast(50.45, 30.52, AT, `city-${i}`);
    }
    vi.setSystemTime(new Date(NOW.getTime() + envMock.VENUE_WEATHER_CACHE_TTL_MS + 1000));
    await fetchWeatherForecast(50.45, 30.52, AT, "fresh");

    // The first key must be gone, so asking again is a real request rather
    // than a hit on an entry that should have been reclaimed long ago.
    const before = spy.mock.calls.length;
    await fetchWeatherForecast(50.45, 30.52, AT, "city-0");
    expect(spy.mock.calls.length).toBe(before + 1);
  });

  it("rejects invalid coordinates and dates without calling out", async () => {
    const spy = vi.fn(() => okResponse(body()));
    vi.stubGlobal("fetch", spy);
    expect(await fetchWeatherForecast(Number.NaN, 30.52, AT)).toBeNull();
    expect(await fetchWeatherForecast(50.45, Number.POSITIVE_INFINITY, AT)).toBeNull();
    expect(await fetchWeatherForecast(50.45, 30.52, new Date("nope"))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
