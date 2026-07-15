import { describe, it, expect } from "vitest";
import {
  computeCityDistribution,
  type CityUserInput,
  type DeparturePin,
} from "./cities.js";

// Rough real coordinates so the nearest-centroid snapping is unambiguous.
const KYIV = { lat: 50.45, lng: 30.52 };
const LVIV = { lat: 49.84, lng: 24.03 };

function user(over: Partial<CityUserInput> & { id: string }): CityUserInput {
  return {
    gender: null,
    homeCityKey: null,
    homeCity: null,
    homeCountryCode: null,
    latitude: null,
    longitude: null,
    ...over,
  };
}

describe("computeCityDistribution", () => {
  it("buckets non-daters by homeCityKey with a gender split", () => {
    const users = [
      user({ id: "1", gender: "female", homeCityKey: "ua:kyiv", homeCity: "Kyiv", homeCountryCode: "UA", latitude: KYIV.lat, longitude: KYIV.lng }),
      user({ id: "2", gender: "male", homeCityKey: "ua:kyiv", homeCity: "Kyiv", homeCountryCode: "UA", latitude: 50.46, longitude: 30.53 }),
      user({ id: "3", gender: "female", homeCityKey: "ua:lviv", homeCity: "Lviv", homeCountryCode: "UA", latitude: LVIV.lat, longitude: LVIV.lng }),
    ];

    const result = computeCityDistribution(users, new Map());

    expect(result.totalUsers).toBe(3);
    expect(result.attribution).toEqual({ byDeparture: 0, byMatchingCity: 3, unknown: 0 });

    const kyiv = result.cities.find((c) => c.cityKey === "ua:kyiv")!;
    expect(kyiv).toMatchObject({ city: "Kyiv", countryCode: "UA", male: 1, female: 1, unknown: 0, total: 2, fromDeparture: 0 });
    // Centroid coordinates ride each city row for the geography map.
    expect(kyiv.lat).toBeCloseTo((KYIV.lat + 50.46) / 2, 3);
    expect(kyiv.lng).toBeCloseTo((KYIV.lng + 30.53) / 2, 3);

    const lviv = result.cities.find((c) => c.cityKey === "ua:lviv")!;
    expect(lviv).toMatchObject({ female: 1, male: 0, total: 1, fromDeparture: 0 });

    // Sorted by total desc → Kyiv first.
    expect(result.cities[0]!.cityKey).toBe("ua:kyiv");
  });

  it("snaps a dater's departure pin to the nearest city, overriding their matching city", () => {
    const users = [
      // Anchors so both cities have a centroid.
      user({ id: "k", gender: "female", homeCityKey: "ua:kyiv", homeCity: "Kyiv", latitude: KYIV.lat, longitude: KYIV.lng }),
      user({ id: "l", gender: "female", homeCityKey: "ua:lviv", homeCity: "Lviv", latitude: LVIV.lat, longitude: LVIV.lng }),
      // Registered in Lviv, but departed from Kyiv → attributed to Kyiv.
      user({ id: "traveler", gender: "male", homeCityKey: "ua:lviv", homeCity: "Lviv", latitude: LVIV.lat, longitude: LVIV.lng }),
    ];
    const pins = new Map<string, DeparturePin>([
      ["traveler", { lat: 50.44, lng: 30.51 }], // ~Kyiv
    ]);

    const result = computeCityDistribution(users, pins);

    const kyiv = result.cities.find((c) => c.cityKey === "ua:kyiv")!;
    expect(kyiv.male).toBe(1); // the traveler
    expect(kyiv.fromDeparture).toBe(1);

    const lviv = result.cities.find((c) => c.cityKey === "ua:lviv")!;
    expect(lviv.male).toBe(0);
    expect(lviv.total).toBe(1); // only the anchor

    expect(result.attribution).toEqual({ byDeparture: 1, byMatchingCity: 2, unknown: 0 });
  });

  it("falls back to an Unknown bucket when there is no city or pin", () => {
    const users = [
      user({ id: "a", gender: "male", homeCityKey: "ua:kyiv", homeCity: "Kyiv", latitude: KYIV.lat, longitude: KYIV.lng }),
      user({ id: "ghost" }), // no gender, no city, no pin
    ];

    const result = computeCityDistribution(users, new Map());

    const unknown = result.cities.find((c) => c.cityKey === "unknown")!;
    expect(unknown).toMatchObject({ city: "Unknown", countryCode: null, unknown: 1, total: 1, lat: null, lng: null });
    expect(result.attribution).toEqual({ byDeparture: 0, byMatchingCity: 1, unknown: 1 });
  });

  it("uses the most-voted display name for a city key", () => {
    const users = [
      user({ id: "1", homeCityKey: "ua:kyiv", homeCity: "Kyiv", latitude: KYIV.lat, longitude: KYIV.lng }),
      user({ id: "2", homeCityKey: "ua:kyiv", homeCity: "Kyiv", latitude: KYIV.lat, longitude: KYIV.lng }),
      user({ id: "3", homeCityKey: "ua:kyiv", homeCity: "kyiv city", latitude: KYIV.lat, longitude: KYIV.lng }),
    ];

    const result = computeCityDistribution(users, new Map());
    expect(result.cities.find((c) => c.cityKey === "ua:kyiv")!.city).toBe("Kyiv");
  });
});
