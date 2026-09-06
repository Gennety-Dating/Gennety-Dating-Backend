import { describe, expect, it } from "vitest";
import {
  CITY_CATALOG,
  DEFAULT_MARKET,
  SUPPORTED_CITY_KEYS,
  SUPPORTED_MARKETS,
  WAITLIST_CITIES,
  cityForCoordinates,
  findCityByKey,
  findMarketByCityKey,
  isSupportedCityKey,
  isWaitlistCityKey,
  marketForCoordinates,
  searchCityCatalog,
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

describe("the waitlist tier", () => {
  it("keeps every catalog entry canonical, unique and timezone-resolvable", () => {
    const keys = new Set<string>();
    for (const city of CITY_CATALOG) {
      expect(city.cityKey).toMatch(/^[a-z]{2}:[a-z0-9-]+$/);
      expect(city.cityKey.startsWith(`${city.countryCode.toLowerCase()}:`)).toBe(true);
      expect(keys.has(city.cityKey)).toBe(false);
      keys.add(city.cityKey);
      // A city whose timezone silently fell back to Kyiv would misfire the
      // Profiler's local windows the day it launches.
      expect(cityKeyToTimeZone(city.cityKey, city.countryCode)).toBe(
        city.countryCode === "DE" ? "Europe/Berlin" : "Europe/Kyiv",
      );
    }
  });

  it("is the catalog minus the launched markets, in display order", () => {
    expect(CITY_CATALOG).toEqual([...SUPPORTED_MARKETS, ...WAITLIST_CITIES]);
    expect(CITY_CATALOG.filter((c) => c.status === "active")).toEqual(SUPPORTED_MARKETS);
    // Countries stay in contiguous runs — the picker groups on this alone.
    const countries = CITY_CATALOG.map((c) => c.countryCode);
    expect(countries).toEqual([...new Set(countries)].flatMap((code) =>
      countries.filter((c) => c === code),
    ));
  });

  it("never lets a waitlist city pass as a launched market", () => {
    for (const city of WAITLIST_CITIES) {
      expect(isWaitlistCityKey(city.cityKey)).toBe(true);
      expect(isSupportedCityKey(city.cityKey)).toBe(false);
      expect(findMarketByCityKey(city.cityKey)).toBeNull();
      expect(findCityByKey(city.cityKey)?.status).toBe("waitlist");
    }
    // …and the reverse: Kyiv is not demand to be recorded, it is a market.
    expect(isWaitlistCityKey("ua:kyiv")).toBe(false);
    // A city nobody has ever heard of is not "waitlisted", it is unknown.
    expect(isWaitlistCityKey("pl:warsaw")).toBe(false);
    expect(isWaitlistCityKey(null)).toBe(false);
  });

  it("searches the catalog in the languages a user actually types", () => {
    const keysFor = (query: string): string[] =>
      searchCityCatalog(query).map((city) => city.cityKey);
    expect(keysFor("Берлин")).toEqual(["de:berlin"]);
    expect(keysFor("München")).toEqual(["de:munich"]);
    expect(keysFor("Кривой Рог")).toEqual(["ua:kryvyi-rih"]);
    expect(keysFor("Одеса")).toEqual(["ua:odesa"]);
    expect(keysFor("Кёльн")).toEqual(["de:cologne"]);
    // Still first-party: a city we have no plans for stays unknown.
    expect(keysFor("Warsaw")).toEqual([]);
    expect(searchCityCatalog("  ")).toHaveLength(CITY_CATALOG.length);
  });

  it("keeps `searchMarkets` launched-only, whatever the catalog holds", () => {
    // Registration's Kyiv-only rail and the city-switch offer both read this;
    // widening it would be how a waitlist city reaches `homeCityKey`.
    for (const query of ["Berlin", "Lviv", "Odesa", "München"]) {
      expect(searchMarkets(query)).toEqual([]);
    }
  });

  it("pre-selects a waitlist city from coordinates, but never as a market", () => {
    expect(cityForCoordinates(52.52, 13.405)?.cityKey).toBe("de:berlin");
    expect(cityForCoordinates(49.8397, 24.0297)?.cityKey).toBe("ua:lviv");
    expect(marketForCoordinates(52.52, 13.405)).toBeNull();
    // Kyiv still wins its own coordinates, from the same catalog scan.
    expect(cityForCoordinates(50.4501, 30.5234)?.cityKey).toBe("ua:kyiv");
    // Warsaw is in neither tier — no city, not a nearest guess.
    expect(cityForCoordinates(52.2297, 21.0122)).toBeNull();
  });
});
