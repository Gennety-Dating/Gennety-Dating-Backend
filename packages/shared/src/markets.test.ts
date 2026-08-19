import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKET,
  SUPPORTED_CITY_KEYS,
  SUPPORTED_MARKETS,
  findMarketByCityKey,
  isSupportedCityKey,
  marketForCoordinates,
  searchMarkets,
} from "./markets.js";
import { cityKeyToTimeZone } from "./timezone.js";

describe("supported markets", () => {
  it("ships Kyiv as the only launched market", () => {
    expect(SUPPORTED_CITY_KEYS).toEqual(["ua:kyiv"]);
    expect(DEFAULT_MARKET.cityKey).toBe("ua:kyiv");
  });

  it("keeps every market's city key canonical and timezone-resolvable", () => {
    for (const market of SUPPORTED_MARKETS) {
      expect(market.cityKey).toMatch(/^[a-z]{2}:[a-z0-9-]+$/);
      expect(market.cityKey.startsWith(`${market.countryCode.toLowerCase()}:`)).toBe(true);
      // A market whose timezone silently fell back would misfire the Profiler's
      // local morning/evening windows.
      expect(cityKeyToTimeZone(market.cityKey, market.countryCode)).toBe("Europe/Kyiv");
    }
  });
});

describe("findMarketByCityKey / isSupportedCityKey", () => {
  it("resolves the launched market case-insensitively", () => {
    expect(findMarketByCityKey("ua:kyiv")?.city).toBe("Kyiv");
    expect(findMarketByCityKey("  UA:KYIV ")?.city).toBe("Kyiv");
    expect(isSupportedCityKey("ua:kyiv")).toBe(true);
  });

  it("refuses cities we have not launched", () => {
    expect(findMarketByCityKey("de:berlin")).toBeNull();
    expect(findMarketByCityKey("ua:lviv")).toBeNull();
    expect(isSupportedCityKey("pl:warsaw")).toBe(false);
    expect(isSupportedCityKey(null)).toBe(false);
    expect(isSupportedCityKey("")).toBe(false);
  });
});

describe("searchMarkets", () => {
  it("matches the local-language names a user actually types", () => {
    for (const query of ["Киев", "Київ", "kyiv", "KIEV", "kij", "Kiew"]) {
      expect(searchMarkets(query).map((m) => m.cityKey)).toEqual(["ua:kyiv"]);
    }
  });

  it("never proposes a city outside the launched set", () => {
    for (const query of ["Berlin", "Lviv", "Warsaw", "Odesa"]) {
      expect(searchMarkets(query)).toEqual([]);
    }
  });

  it("returns the full list for an empty query (the default picker)", () => {
    expect(searchMarkets("  ")).toHaveLength(SUPPORTED_MARKETS.length);
  });
});

describe("marketForCoordinates", () => {
  it("recognises the city, out to its own edges", () => {
    expect(marketForCoordinates(50.4501, 30.5234)?.cityKey).toBe("ua:kyiv"); // centre
    expect(marketForCoordinates(50.535, 30.36)?.cityKey).toBe("ua:kyiv"); // Pushcha-Vodytsia, ~15 km
    expect(marketForCoordinates(50.27, 30.55)?.cityKey).toBe("ua:kyiv"); // Koncha-Zaspa, ~20 km
  });

  it("returns null outside every launched market", () => {
    expect(marketForCoordinates(49.8397, 24.0297)).toBeNull(); // Lviv
    expect(marketForCoordinates(52.52, 13.405)).toBeNull(); // Berlin
    expect(marketForCoordinates(49.4444, 32.0598)).toBeNull(); // Cherkasy, ~160 km
    // Boryspil, ~33 km. A separate city that resolved to Kyiv under the old
    // 60 km commuter-belt radius (narrowed to the city itself 2026-08-18).
    expect(marketForCoordinates(50.35, 30.955)).toBeNull();
  });

  it("still admits the near suburbs a circle cannot separate out", () => {
    // Not an endorsement — a statement of what 21 km can and cannot do.
    // Vyshneve is 12.8 km from the centroid while Pushcha-Vodytsia (a Kyiv
    // district, asserted above) is 14.9 km, so no radius takes the whole city
    // and leaves the suburbs. Only a boundary polygon would. See `markets.ts`.
    expect(marketForCoordinates(50.39, 30.37)?.cityKey).toBe("ua:kyiv"); // Vyshneve
    expect(marketForCoordinates(50.585, 30.49)?.cityKey).toBe("ua:kyiv"); // Vyshhorod
  });

  it("returns null for unusable coordinates instead of guessing", () => {
    expect(marketForCoordinates(Number.NaN, 30.5)).toBeNull();
    expect(marketForCoordinates(50.45, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
