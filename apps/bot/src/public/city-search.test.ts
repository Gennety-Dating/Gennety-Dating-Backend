import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cityCatalogHits,
  resolveCityFromCoordinates,
  searchCities,
  supportedCityHits,
} from "./city-search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("city search", () => {
  it("offers the whole catalog and never calls a provider", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(searchCities("Kyiv")).toMatchObject([
      { homeCity: "Kyiv", homeCountryCode: "UA", homeCityKey: "ua:kyiv", status: "active" },
    ]);
    expect(searchCities("Киев")).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds a waitlist city and marks it as one", () => {
    // The whole point of the 2026-09-04 change: this used to be `[]`, which
    // read to the user as "your city does not exist".
    expect(searchCities("Berlin")).toMatchObject([
      { homeCityKey: "de:berlin", status: "waitlist" },
    ]);
    expect(searchCities("Львов")).toMatchObject([
      { homeCityKey: "ua:lviv", status: "waitlist" },
    ]);
    expect(searchCities("München")).toMatchObject([
      { homeCityKey: "de:munich", status: "waitlist" },
    ]);
  });

  it("still knows nothing about a city outside our own catalog", () => {
    expect(searchCities("Warsaw")).toEqual([]);
    expect(searchCities("Tokyo")).toEqual([]);
  });

  it("exposes the launched set and the full picker list separately", () => {
    expect(supportedCityHits().map((hit) => hit.homeCityKey)).toEqual(["ua:kyiv"]);

    const catalog = cityCatalogHits();
    // Launched market first, then the expansion list grouped by country.
    expect(catalog[0]).toMatchObject({ homeCityKey: "ua:kyiv", status: "active" });
    expect(catalog.filter((hit) => hit.status === "active")).toHaveLength(1);
    expect(catalog.map((hit) => hit.homeCountryCode)).toEqual([
      ...Array(5).fill("UA"),
      ...Array(15).fill("DE"),
    ]);
  });
});

describe("resolveCityFromCoordinates", () => {
  it("pre-selects the market a user is actually in", () => {
    expect(resolveCityFromCoordinates(50.4501, 30.5234)).toMatchObject({
      supported: true,
      city: { homeCityKey: "ua:kyiv", latitude: 50.4501, longitude: 30.5234 },
    });
  });

  it("names a waitlist city without calling it supported", () => {
    // `supported` still means "launched", so an older cached bundle reads it
    // first and shows its "not launched here" note instead of saving.
    expect(resolveCityFromCoordinates(52.52, 13.405)).toMatchObject({
      supported: false,
      city: { homeCityKey: "de:berlin", status: "waitlist" },
    });
  });

  it("refuses to guess a city for coordinates outside the whole catalog", () => {
    // Pre-2026-07-28 this silently answered "Kyiv" for any point on earth
    // whenever PLACES_API_KEY was unset.
    expect(resolveCityFromCoordinates(52.2297, 21.0122)).toEqual({
      supported: false,
      city: null,
    }); // Warsaw
    expect(resolveCityFromCoordinates(35.6762, 139.6503)).toEqual({
      supported: false,
      city: null,
    }); // Tokyo
  });
});
