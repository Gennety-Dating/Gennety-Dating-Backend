import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCityFromCoordinates, searchCities } from "./city-search.js";

const originalPlacesKey = process.env.PLACES_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalPlacesKey === undefined) delete process.env.PLACES_API_KEY;
  else process.env.PLACES_API_KEY = originalPlacesKey;
});

describe("city search provider boundaries", () => {
  it("bounds the Places text-search request", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        places: [
          {
            id: "place-1",
            displayName: { text: "Kyiv" },
            formattedAddress: "Kyiv, Ukraine",
            location: { latitude: 50.45, longitude: 30.52 },
            addressComponents: [
              { longText: "Kyiv", types: ["locality"] },
              { shortText: "UA", types: ["country"] },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchCities("Kyiv")).resolves.toMatchObject([
      { homeCity: "Kyiv", homeCountryCode: "UA" },
    ]);
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds the reverse-geocode request", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        results: [
          {
            place_id: "place-1",
            formatted_address: "Kyiv, Ukraine",
            geometry: { location: { lat: 50.45, lng: 30.52 } },
            address_components: [
              { long_name: "Kyiv", types: ["locality"] },
              { short_name: "UA", types: ["country"] },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveCityFromCoordinates(50.45, 30.52)).resolves.toMatchObject({
      homeCity: "Kyiv",
      homeCountryCode: "UA",
    });
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
