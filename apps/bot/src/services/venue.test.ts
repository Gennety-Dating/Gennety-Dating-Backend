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
  gate,
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

  it("falls back to relaxed price ceiling on tier-1 reject (all results were EXPENSIVE)", async () => {
    // Tier-1 result is EXPENSIVE — strict gate rejects it. But in
    // tier-2 (relaxed), the same place passes.
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
    const venue = await client.pickAtMidpoint!(midpointInput({ category: "restaurant" }));
    // Tier-1 gates fail strict mode → tier-2 reuses the same result
    // list (single fetch optimisation) and the relaxed gate accepts.
    // We assert the picker landed on the relaxed result.
    expect(venue.name).toBe("Premium Spot");
    expect(calls.length).toBe(1); // No second searchNearby call needed.
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
      /no usable results/,
    );
  });
});

describe("pickVenueAtMidpoint (high-level wrapper)", () => {
  it("falls back to the local stub on any throw — match must always finalise", async () => {
    const throwingClient = {
      async pick() {
        throw new Error("fail");
      },
      async pickAtMidpoint() {
        throw new Error("fail");
      },
    };
    const venue = await pickVenueAtMidpoint(midpointInput(), throwingClient);
    expect(venue.name).toMatch(/Neighbourhood/);
    expect(venue.googleMapsUri).toBeNull();
  });
});

describe("localStubVenueClient", () => {
  it("returns null googleMapsUri so downstream UI knows not to render the link", async () => {
    const client = localStubVenueClient();
    const venue = await client.pickAtMidpoint!(midpointInput());
    expect(venue.googleMapsUri).toBeNull();
  });
});
