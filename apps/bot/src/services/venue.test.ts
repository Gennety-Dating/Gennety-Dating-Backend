/**
 * Tests for the Places API (New) venue picker. The pure helpers
 * (`gate`, `score`) are exercised directly. The HTTP path is exercised
 * through `createPlacesVenueClient` with `fetch` patched onto
 * `globalThis` so we don't pull in a mocking framework — the contract
 * is a single POST per tier, and tests assert what the picker does
 * with each tier's response.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createPlacesVenueClient,
  localStubVenueClient,
  pickVenueAtMidpoint,
  searchVenueCandidates,
  gate,
  isBlockedVenueName,
  score,
  type MidpointVenueInput,
} from "./venue.js";

const KYIV_CENTER = { lat: 50.4501, lng: 30.5234 };

function midpointInput(
  overrides: Partial<MidpointVenueInput> = {},
): MidpointVenueInput {
  return {
    lat: KYIV_CENTER.lat,
    lng: KYIV_CENTER.lng,
    category: "cafe",
    keywords: [],
    radiusMeters: 1500,
    ...overrides,
  };
}

function place(overrides: Record<string, unknown> = {}) {
  return {
    displayName: { text: "Test Cafe" },
    formattedAddress: "123 Test St",
    businessStatus: "OPERATIONAL",
    priceLevel: "PRICE_LEVEL_MODERATE",
    rating: 4.5,
    userRatingCount: 200,
    googleMapsUri: "https://maps.google.com/?cid=42",
    location: { latitude: KYIV_CENTER.lat, longitude: KYIV_CENTER.lng },
    ...overrides,
  };
}

describe("gate (quality filter)", () => {
  it("rejects non-OPERATIONAL places (closed permanently are NOT pre-filtered by the API)", () => {
    expect(gate(place({ businessStatus: "CLOSED_PERMANENTLY" }), "cafe", true)).toBe(false);
    // `undefined` businessStatus is also rejected — the legacy fix.
    expect(gate(place({ businessStatus: undefined }), "cafe", true)).toBe(false);
  });

  it("rejects places with too few reviews", () => {
    expect(gate(place({ userRatingCount: 12 }), "cafe", true)).toBe(false);
  });

  it("rejects places with sub-4.0 rating", () => {
    expect(gate(place({ rating: 3.7 }), "cafe", true)).toBe(false);
  });

  it("rejects EXPENSIVE food places under strict mode", () => {
    expect(gate(place({ priceLevel: "PRICE_LEVEL_EXPENSIVE" }), "restaurant", true)).toBe(false);
    expect(gate(place({ priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE" }), "cafe", true)).toBe(false);
  });

  it("accepts EXPENSIVE food places under relaxed mode (tier-2 fallback)", () => {
    expect(gate(place({ priceLevel: "PRICE_LEVEL_EXPENSIVE" }), "restaurant", false)).toBe(true);
  });

  it("does NOT apply the price filter to non-food categories (parks/museums often have no price)", () => {
    expect(gate(place({ priceLevel: "PRICE_LEVEL_EXPENSIVE" }), "park", true)).toBe(true);
    expect(gate(place({ priceLevel: undefined }), "museum", true)).toBe(true);
  });

  it("accepts a normal popular cafe", () => {
    expect(gate(place(), "cafe", true)).toBe(true);
  });

  it("rejects when displayName is missing (defensive — API shouldn't return this but guard anyway)", () => {
    expect(gate(place({ displayName: undefined }), "cafe", true)).toBe(false);
    expect(gate(place({ displayName: { text: "" } }), "cafe", true)).toBe(false);
  });

  it("rejects blocked place types (gas station, hotel, etc.) even with a great rating", () => {
    // The reported "date at a gas station" bug: a high-rated petrol station
    // with a coffee corner leaks through searchText (which doesn't constrain
    // by includedTypes). The type deny-list catches it.
    expect(
      gate(place({ primaryType: "gas_station", rating: 4.8, userRatingCount: 5000 }), "cafe", true),
    ).toBe(false);
    expect(
      gate(place({ types: ["convenience_store", "gas_station"], rating: 4.6 }), "cafe", false),
    ).toBe(false);
    expect(gate(place({ primaryType: "lodging" }), "restaurant", true)).toBe(false);
  });

  it("rejects operator-blocked venue brands in strict and relaxed search", () => {
    expect(isBlockedVenueName("Musafir Podil")).toBe(true);
    expect(isBlockedVenueName("Ресторан Мусафір")).toBe(true);
    expect(isBlockedVenueName("Blur Coffee")).toBe(false);
    expect(
      gate(place({ displayName: { text: "Musafir" } }), "restaurant", true),
    ).toBe(false);
    expect(
      gate(place({ displayName: { text: "Мусафір Осокорки" } }), "restaurant", false),
    ).toBe(false);
  });

  it("still accepts a genuine venue whose types are absent or category-appropriate", () => {
    // Missing types must NOT be treated as blocked (deny-list semantics).
    expect(gate(place({ primaryType: undefined, types: undefined }), "cafe", true)).toBe(true);
    expect(gate(place({ primaryType: "coffee_shop", types: ["cafe"] }), "cafe", true)).toBe(true);
    expect(gate(place({ primaryType: "italian_restaurant" }), "restaurant", true)).toBe(true);
  });
});

describe("score (ranking)", () => {
  it("ranks higher-rated place above lower-rated when reviews and distance are equal", () => {
    const a = place({ rating: 4.8 });
    const b = place({ rating: 4.1 });
    expect(score(a, KYIV_CENTER, 1500)).toBeGreaterThan(score(b, KYIV_CENTER, 1500));
  });

  it("uses log10 of review count, so 1000-vs-100 reviews matters less than 100-vs-10", () => {
    const tiny = place({ rating: 4.5, userRatingCount: 50 });
    const big = place({ rating: 4.5, userRatingCount: 5000 });
    const ratio = score(big, KYIV_CENTER, 1500) / score(tiny, KYIV_CENTER, 1500);
    // log10(5010) / log10(60) ≈ 3.7 / 1.78 ≈ 2.08 — should be in this ballpark
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.5);
  });

  it("penalises distant places — same rating + reviews, place at edge of radius scores < center", () => {
    const center = place({ location: { latitude: KYIV_CENTER.lat, longitude: KYIV_CENTER.lng } });
    // ~1.4 km north
    const far = place({
      location: { latitude: KYIV_CENTER.lat + 0.0125, longitude: KYIV_CENTER.lng },
    });
    expect(score(center, KYIV_CENTER, 1500)).toBeGreaterThan(score(far, KYIV_CENTER, 1500));
  });
});

describe("createPlacesVenueClient.pickAtMidpoint", () => {
  let originalFetch: typeof globalThis.fetch;
  let calls: { url: string; body: unknown }[];
  let responses: unknown[];

  beforeEach(() => {
    calls = [];
    responses = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url, body });
      const next = responses.shift() ?? { places: [] };
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as never;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls Places API (New) v1 searchNearby with the expected field mask + circle restriction", async () => {
    responses = [{ places: [place({ displayName: { text: "Best Cafe" } })] }];
    const client = createPlacesVenueClient("test-key");
    const venue = await client.pickAtMidpoint!(midpointInput());

    expect(venue.name).toBe("Best Cafe");
    expect(venue.googleMapsUri).toBe("https://maps.google.com/?cid=42");

    expect(calls[0]!.url).toBe(
      "https://places.googleapis.com/v1/places:searchNearby",
    );
    const reqBody = calls[0]!.body as Record<string, unknown>;
    expect(reqBody.includedTypes).toEqual(["cafe"]);
    expect((reqBody.locationRestriction as any).circle.radius).toBe(1500);
  });

  it("picks the highest-scoring candidate, NOT the first result", async () => {
    // First candidate is mediocre, second is the gem. Server ordering
    // shouldn't matter — score wins.
    responses = [
      {
        places: [
          place({ displayName: { text: "Mediocre Cafe" }, rating: 4.0, userRatingCount: 35 }),
          place({ displayName: { text: "Gem Cafe" }, rating: 4.7, userRatingCount: 2000 }),
        ],
      },
    ];
    const client = createPlacesVenueClient("test-key");
    const venue = await client.pickAtMidpoint!(midpointInput());
    expect(venue.name).toBe("Gem Cafe");
  });

  it("filters out non-OPERATIONAL places even if they outrank operational ones", async () => {
    responses = [
      {
        places: [
          place({
            displayName: { text: "Closed Forever" },
            rating: 4.9,
            userRatingCount: 9999,
            businessStatus: "CLOSED_PERMANENTLY",
          }),
          place({ displayName: { text: "Real Cafe" }, rating: 4.2, userRatingCount: 80 }),
        ],
      },
    ];
    const client = createPlacesVenueClient("test-key");
    const venue = await client.pickAtMidpoint!(midpointInput());
    expect(venue.name).toBe("Real Cafe");
  });

  it("never auto-relaxes the price ceiling when all results are EXPENSIVE", async () => {
    responses = [
      {
        places: [
          place({
            displayName: { text: "Premium Spot" },
            priceLevel: "PRICE_LEVEL_EXPENSIVE",
          }),
        ],
      },
    ];
    const client = createPlacesVenueClient("test-key");
    await expect(client.pickAtMidpoint!(midpointInput({ category: "restaurant" })))
      .rejects.toMatchObject({ code: "no_candidates" });
  });

  it("falls back to searchText when searchNearby returns zero results", async () => {
    responses = [
      { places: [] }, // searchNearby
      { places: [place({ displayName: { text: "Found via text" } })] }, // searchText
    ];
    const client = createPlacesVenueClient("test-key");
    const venue = await client.pickAtMidpoint!(
      midpointInput({ keywords: ["cosy"] }),
    );
    expect(venue.name).toBe("Found via text");
    expect(calls.length).toBe(2);
    expect(calls[0]!.url).toContain("searchNearby");
    expect(calls[1]!.url).toContain("searchText");
    // Text search must be biased on the midpoint so it doesn't return
    // a Cosy Cafe in another country.
    expect((calls[1]!.body as any).locationBias).toBeDefined();
  });

  it("propagates a thrown error when even tier-3 searchText returns no usable result", async () => {
    responses = [
      { places: [] }, // tier-1
      { places: [] }, // tier-3 (text)
    ];
    const client = createPlacesVenueClient("test-key");
    await expect(client.pickAtMidpoint!(midpointInput())).rejects.toThrow(
      /no eligible results/,
    );
  });

  it("does NOT surface a blocked-type place from tier-3 — throws instead of returning a gas station", async () => {
    // tier-3 searchText returns ONLY an operational, high-rated gas station.
    // The old tier-4 "any operational" path would have returned it; now the
    // gate's type deny-list rejects it and the picker throws → stub fallback.
    responses = [
      { places: [] }, // tier-1 searchNearby
      {
        places: [
          place({
            displayName: { text: "MEGA Petrol Station" },
            primaryType: "gas_station",
            types: ["gas_station", "convenience_store"],
            rating: 4.7,
            userRatingCount: 1200,
          }),
        ],
      }, // tier-3 searchText
    ];
    const client = createPlacesVenueClient("test-key");
    await expect(client.pickAtMidpoint!(midpointInput())).rejects.toThrow(
      /no eligible results/,
    );
  });
});

describe("pickVenueAtMidpoint (high-level wrapper)", () => {
  it("surfaces provider outage instead of scheduling a fake venue", async () => {
    const throwingClient = {
      async pick() {
        throw new Error("fail");
      },
      async pickAtMidpoint() {
        throw new Error("fail");
      },
    };
    await expect(pickVenueAtMidpoint(midpointInput(), throwingClient))
      .rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

describe("localStubVenueClient", () => {
  it("cannot fabricate a midpoint venue", async () => {
    const client = localStubVenueClient();
    await expect(client.pickAtMidpoint!(midpointInput()))
      .rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

describe("searchVenueCandidates (curated seeder)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockNearby(places: unknown[]) {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ places }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as never;
  }

  it("returns only gated candidates, sorted best-first, with review metadata", async () => {
    mockNearby([
      place({ displayName: { text: "Mediocre" }, rating: 4.0, userRatingCount: 35 }),
      place({ displayName: { text: "Gem" }, rating: 4.8, userRatingCount: 3000 }),
      place({ displayName: { text: "Too few reviews" }, userRatingCount: 5 }), // gated out
    ]);
    const candidates = await searchVenueCandidates("test-key", midpointInput());
    expect(candidates.map((c) => c.name)).toEqual(["Gem", "Mediocre"]);
    expect(candidates[0]).toMatchObject({
      category: "cafe",
      rating: 4.8,
      userRatingCount: 3000,
      googleMapsUri: "https://maps.google.com/?cid=42",
    });
  });

  it("excludes blocked-type places (the seeder must not curate a gas station)", async () => {
    mockNearby([
      place({
        displayName: { text: "Petrol + Coffee" },
        primaryType: "gas_station",
        rating: 4.9,
        userRatingCount: 5000,
      }),
      place({ displayName: { text: "Real Cafe" } }),
    ]);
    const candidates = await searchVenueCandidates("test-key", midpointInput());
    expect(candidates.map((c) => c.name)).toEqual(["Real Cafe"]);
  });

  it("excludes operator-blocked brands from curated seeder candidates", async () => {
    mockNearby([
      place({ displayName: { text: "Musafir" } }),
      place({ displayName: { text: "Passenger Gastro Bar" } }),
    ]);
    const candidates = await searchVenueCandidates(
      "test-key",
      midpointInput({ category: "restaurant" }),
    );
    expect(candidates.map((c) => c.name)).toEqual(["Passenger Gastro Bar"]);
  });
});
