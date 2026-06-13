/**
 * Tests for the curated-venue resolver. The pure ranker (`rankCuratedVenues`)
 * is exercised directly with hand-placed coordinates. `resolveVenue` is tested
 * with injected deps so neither the DB nor Google Places is touched.
 */

import { describe, it, expect, vi } from "vitest";
import {
  rankCuratedVenues,
  resolveVenue,
  priorityWeight,
  isValidVenueCategory,
  isVenueOpenAt,
  type CuratedVenueRow,
  type ResolveVenueInput,
} from "./curated-venue.js";
import type { RegularOpeningHours } from "./venue.js";

// A fixed slot used across ranking tests. Venues default to null hours/offset,
// which `isVenueOpenAt` treats as always-open, so it never interferes unless a
// test sets hours explicitly.
const AGREED_TIME = new Date(Date.UTC(2026, 5, 2, 16, 0));

// A compact pair: origins ~4.4 km apart on the same meridian; midpoint ≈ 50.45.
const ORIGIN_A = { lat: 50.43, lng: 30.5 };
const ORIGIN_B = { lat: 50.47, lng: 30.5 };
const MID = { lat: 50.45, lng: 30.5 };

function row(overrides: Partial<CuratedVenueRow> = {}): CuratedVenueRow {
  return {
    name: "Test Cafe",
    address: "1 Test St",
    lat: MID.lat,
    lng: MID.lng,
    googleMapsUri: "https://maps.google.com/?cid=1",
    category: "cafe",
    priority: 2,
    vibeTags: [],
    utcOffsetMinutes: null,
    openingHours: null,
    ...overrides,
  };
}

const baseCtx = {
  originA: ORIGIN_A,
  originB: ORIGIN_B,
  category: "cafe" as const,
  keywords: [] as string[],
  agreedTime: AGREED_TIME,
};

describe("priorityWeight", () => {
  it("maps 1 → 1.0, 2 → 0.85, 3 → 0.7 and clamps", () => {
    expect(priorityWeight(1)).toBeCloseTo(1.0);
    expect(priorityWeight(2)).toBeCloseTo(0.85);
    expect(priorityWeight(3)).toBeCloseTo(0.7);
    expect(priorityWeight(99)).toBe(0.4); // floor
    expect(priorityWeight(Number.NaN)).toBeCloseTo(0.85); // defaults to 2
  });
});

describe("rankCuratedVenues", () => {
  it("prefers the higher-priority (lower number) venue at the same location", () => {
    const best = rankCuratedVenues(
      [
        row({ name: "Meh", priority: 3 }),
        row({ name: "Great", priority: 1 }),
      ],
      baseCtx,
    );
    expect(best?.name).toBe("Great");
  });

  it("minimises the WORSE commute, not distance to the midpoint", () => {
    // A venue sitting on top of origin A has distA≈0 but a long distB; the
    // midpoint venue has a small, balanced max(distA,distB) and should win.
    const best = rankCuratedVenues(
      [
        row({ name: "At A (unfair)", lat: ORIGIN_A.lat, lng: ORIGIN_A.lng }),
        row({ name: "Midpoint (fair)", lat: MID.lat, lng: MID.lng }),
      ],
      baseCtx,
    );
    expect(best?.name).toBe("Midpoint (fair)");
  });

  it("returns null when every venue is beyond the max-commute cap", () => {
    // Origins ~44 km apart → even the midpoint is ~22 km from each, over the cap.
    const far = rankCuratedVenues([row({ lat: 50.5, lng: 30.5 })], {
      ...baseCtx,
      originA: { lat: 50.3, lng: 30.5 },
      originB: { lat: 50.7, lng: 30.5 },
    });
    expect(far).toBeNull();
  });

  it("falls back exact-category → cafe → any", () => {
    const rows = [
      row({ name: "Park", category: "park" }),
      row({ name: "Cafe", category: "cafe" }),
    ];
    // No restaurant rows → cafe fallback.
    expect(rankCuratedVenues(rows, { ...baseCtx, category: "restaurant" })?.name).toBe("Cafe");
    // No cafe either → any (only park present).
    expect(
      rankCuratedVenues([row({ name: "Park", category: "park" })], {
        ...baseCtx,
        category: "museum",
      })?.name,
    ).toBe("Park");
  });

  it("breaks a tie in favour of a vibe-tag match", () => {
    const best = rankCuratedVenues(
      [
        row({ name: "Plain" }),
        row({ name: "Vegan", vibeTags: ["vegan"] }),
      ],
      { ...baseCtx, keywords: ["vegan"] },
    );
    expect(best?.name).toBe("Vegan");
  });

  it("skips a venue that's closed at the agreed slot in favour of an open one", () => {
    // AGREED_TIME is 16:00 UTC; with offset 0 that's 16:00 local on its weekday.
    const day = new Date(AGREED_TIME.getTime()).getUTCDay();
    const closed: RegularOpeningHours = {
      periods: [{ open: { day, hour: 9 }, close: { day, hour: 12 } }], // shut by 16:00
    };
    const best = rankCuratedVenues(
      [
        // Best on every other axis (priority 1) but closed at the slot.
        row({ name: "Closed Gem", priority: 1, utcOffsetMinutes: 0, openingHours: closed }),
        // Lower priority but open (no hours → always open).
        row({ name: "Open Cafe", priority: 3 }),
      ],
      baseCtx,
    );
    expect(best?.name).toBe("Open Cafe");
  });

  it("skips an operator-blocked brand even when it would otherwise rank first", () => {
    const best = rankCuratedVenues(
      [
        row({ name: "Musafir Podil", priority: 1 }),
        row({ name: "Passenger Gastro Bar", priority: 2 }),
      ],
      baseCtx,
    );
    expect(best?.name).toBe("Passenger Gastro Bar");
  });
});

describe("isVenueOpenAt", () => {
  const day = new Date(AGREED_TIME.getTime()).getUTCDay(); // weekday of the slot (offset 0)

  it("treats missing data as open (never filters on absent info)", () => {
    expect(isVenueOpenAt(null, 0, AGREED_TIME)).toBe(true);
    expect(isVenueOpenAt({ periods: [] }, 0, AGREED_TIME)).toBe(true);
    // No offset → can't localize → assume open.
    expect(
      isVenueOpenAt({ periods: [{ open: { day, hour: 0 }, close: { day, hour: 1 } }] }, null, AGREED_TIME),
    ).toBe(true);
  });

  it("is open inside the window and closed outside (offset 0)", () => {
    const open: RegularOpeningHours = { periods: [{ open: { day, hour: 9 }, close: { day, hour: 22 } }] };
    const closed: RegularOpeningHours = { periods: [{ open: { day, hour: 9 }, close: { day, hour: 12 } }] };
    expect(isVenueOpenAt(open, 0, AGREED_TIME)).toBe(true); // 16:00 ∈ [09,22)
    expect(isVenueOpenAt(closed, 0, AGREED_TIME)).toBe(false); // 16:00 ∉ [09,12)
  });

  it("applies the UTC offset to the wall-clock", () => {
    const hours: RegularOpeningHours = { periods: [{ open: { day, hour: 9 }, close: { day, hour: 18 } }] };
    // +180 → local 19:00 (after close 18:00) → closed.
    expect(isVenueOpenAt(hours, 180, AGREED_TIME)).toBe(false);
    // -120 → local 14:00 (inside) → open.
    expect(isVenueOpenAt(hours, -120, AGREED_TIME)).toBe(true);
  });

  it("treats an open period with no close as always-open", () => {
    expect(isVenueOpenAt({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }, 0, AGREED_TIME)).toBe(true);
  });

  it("handles a window that wraps past the week boundary (Sat→Sun)", () => {
    // Find a Sunday 01:00 UTC instant.
    let sundayEarly = new Date(Date.UTC(2026, 5, 1, 1, 0));
    while (sundayEarly.getUTCDay() !== 0) {
      sundayEarly = new Date(sundayEarly.getTime() + 86_400_000);
    }
    const hours: RegularOpeningHours = {
      periods: [{ open: { day: 6, hour: 22 }, close: { day: 0, hour: 3 } }], // Sat 22:00 → Sun 03:00
    };
    expect(isVenueOpenAt(hours, 0, sundayEarly)).toBe(true); // Sun 01:00 ∈ wrapped window
  });
});

describe("resolveVenue", () => {
  function input(overrides: Partial<ResolveVenueInput> = {}): ResolveVenueInput {
    return {
      universityDomain: "example.edu",
      midpoint: MID,
      originA: ORIGIN_A,
      originB: ORIGIN_B,
      radiusMeters: 2000,
      category: "cafe",
      keywords: [],
      agreedTime: AGREED_TIME,
      ...overrides,
    };
  }

  it("returns the curated venue and does NOT call Places when curated hits", async () => {
    const pickPlaces = vi.fn();
    const venue = await resolveVenue(input(), {
      pickCurated: async () => ({
        name: "Curated Spot",
        address: "2 Curated Rd",
        googleMapsUri: "https://maps.google.com/?cid=9",
      }),
      pickPlaces,
    });
    expect(venue.name).toBe("Curated Spot");
    expect(pickPlaces).not.toHaveBeenCalled();
  });

  it("falls back to Places (with the midpoint) when curated misses", async () => {
    const pickPlaces = vi.fn(async () => ({
      name: "Places Spot",
      address: "3 Places Ave",
      googleMapsUri: null,
    }));
    const venue = await resolveVenue(input({ keywords: ["jazz"] }), {
      pickCurated: async () => null,
      pickPlaces,
    });
    expect(venue.name).toBe("Places Spot");
    expect(pickPlaces).toHaveBeenCalledWith({
      lat: MID.lat,
      lng: MID.lng,
      category: "cafe",
      keywords: ["jazz"],
      radiusMeters: 2000,
    });
  });
});

describe("isValidVenueCategory", () => {
  it("accepts whitelisted categories and rejects junk", () => {
    expect(isValidVenueCategory("cafe")).toBe(true);
    expect(isValidVenueCategory("museum")).toBe(true);
    expect(isValidVenueCategory("gas_station")).toBe(false);
    expect(isValidVenueCategory("")).toBe(false);
  });
});
