import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveMarketFromCoordinates,
  searchCities,
  supportedCityHits,
} from "./city-search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("city search", () => {
  it("offers only launched markets and never calls a provider", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(searchCities("Kyiv")).toMatchObject([
      { homeCity: "Kyiv", homeCountryCode: "UA", homeCityKey: "ua:kyiv" },
    ]);
    expect(searchCities("Киев")).toHaveLength(1);
    expect(searchCities("Berlin")).toEqual([]);
    expect(searchCities("Lviv")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes the default picker list", () => {
    expect(supportedCityHits().map((hit) => hit.homeCityKey)).toEqual(["ua:kyiv"]);
  });
});

describe("resolveMarketFromCoordinates", () => {
  it("pre-selects the market a user is actually in", () => {
    expect(resolveMarketFromCoordinates(50.4501, 30.5234)).toMatchObject({
      supported: true,
      city: { homeCityKey: "ua:kyiv", latitude: 50.4501, longitude: 30.5234 },
    });
  });

  it("refuses to guess a market for coordinates outside every launched city", () => {
    // Pre-2026-07-28 this silently answered "Kyiv" for any point on earth
    // whenever PLACES_API_KEY was unset.
    expect(resolveMarketFromCoordinates(52.52, 13.405)).toEqual({
      supported: false,
      city: null,
    });
    expect(resolveMarketFromCoordinates(49.8397, 24.0297)).toEqual({
      supported: false,
      city: null,
    });
  });
});
