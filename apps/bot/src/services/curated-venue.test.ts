/**
 * Tests for the curated-venue resolver. The pure ranker (`rankCuratedVenues`)
 * is exercised directly with hand-placed coordinates. `resolveVenue` is tested
 * with injected deps so neither the DB nor Google Places is touched.
 */

import { VENUE_CATEGORY_WHITELIST } from "./vibe-parser.js";
import { describe, it, expect, vi } from "vitest";
import {
  rankCuratedVenues,
  resolveVenue,
  rowToVenue,
  priorityWeight,
  isValidVenueCategory,
  isVenueOpenAt,
  type CuratedVenueRow,
  type ResolveVenueInput,
  EXCLUDED_VENUE_CATEGORIES,
  OFFERABLE_CATEGORY_FILTER,
  isOfferableVenueCategory,
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
    placeId: null,
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

  it("returns the curated venue and does NOT call Places search when curated hits", async () => {
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

  // Regression: curated rows store no imagery, so before this the curated
  // branch shipped `photoName: null` and every curated date card rendered its
  // bare gradient — with curated being the PRIMARY source, that was the common
  // path. The cover must be resolved from the row's stable `placeId`.
  it("fills a curated pick's cover photo from its placeId", async () => {
    process.env.PLACES_API_KEY = "k";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ photos: [{ name: "places/c9/photos/lead" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const venue = await resolveVenue(input(), {
      pickCurated: async () => ({
        name: "Curated Spot",
        address: "2 Curated Rd",
        googleMapsUri: "https://maps.google.com/?cid=9",
        placeId: "c9",
        photoName: null,
      }),
      pickPlaces: vi.fn(),
    });

    expect(venue.photoName).toBe("places/c9/photos/lead");
    expect(fetchMock.mock.calls[0]![0]).toContain("/v1/places/c9");
    vi.unstubAllGlobals();
    delete process.env.PLACES_API_KEY;
  });

  // The complement of the test above, and the cheaper path: once the nightly
  // re-validation cron has written `photoRefs` onto the row, the cover is free.
  // Before 2026-08-23 the cron wrote that column and nothing read it, so this
  // request was bought again on every single assignment.
  it("does NOT buy a cover the row already carries", async () => {
    process.env.PLACES_API_KEY = "k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const venue = await resolveVenue(input(), {
      pickCurated: async () => ({
        name: "Scanned Spot",
        address: "3 Scanned Rd",
        googleMapsUri: null,
        placeId: "c10",
        photoName: "places/c10/photos/from-the-row",
      }),
      pickPlaces: vi.fn(),
    });

    expect(venue.photoName).toBe("places/c10/photos/from-the-row");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    delete process.env.PLACES_API_KEY;
  });

  it("keeps the curated pick when the cover lookup fails", async () => {
    process.env.PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("places down")));

    const venue = await resolveVenue(input(), {
      pickCurated: async () => ({
        name: "Curated Spot",
        address: "2 Curated Rd",
        googleMapsUri: null,
        placeId: "c9",
        photoName: null,
      }),
      pickPlaces: vi.fn(),
    });

    // A missing photo is cosmetic (the card falls back to its gradient); it must
    // never take the venue assignment down with it.
    expect(venue.name).toBe("Curated Spot");
    expect(venue.photoName).toBeNull();
    vi.unstubAllGlobals();
    delete process.env.PLACES_API_KEY;
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

describe("rowToVenue", () => {
  const row = (over: Partial<CuratedVenueRow> = {}): CuratedVenueRow => ({
    name: "Row Cafe",
    address: "1 Row St",
    lat: 50.45,
    lng: 30.52,
    googleMapsUri: null,
    category: "cafe",
    priority: 1,
    vibeTags: [],
    utcOffsetMinutes: null,
    openingHours: null,
    placeId: "p1",
    ...over,
  });

  // This is the line that stops the cover being re-bought on every assignment:
  // the nightly cron writes `photoRefs`, and until 2026-08-23 nothing read it.
  it("takes the cover straight off the row's photoRefs", () => {
    const venue = rowToVenue(row({ photoRefs: ["places/p1/photos/a", "places/p1/photos/b"] }));
    expect(venue.photoName).toBe("places/p1/photos/a"); // Google's order is cover-first
  });

  it("leaves the cover null for a row the cron has not scanned yet", () => {
    // The one case that still costs a Place Details request in `resolveVenue`.
    expect(rowToVenue(row({ photoRefs: [] })).photoName).toBeNull();
    expect(rowToVenue(row()).photoName).toBeNull();
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

describe("EXCLUDED_VENUE_CATEGORIES", () => {
  it("excludes museums from what the product offers", () => {
    expect(isOfferableVenueCategory("museum")).toBe(false);
  });

  it("leaves every other whitelisted category offerable", () => {
    for (const category of VENUE_CATEGORY_WHITELIST) {
      if (category === "museum") continue;
      expect(isOfferableVenueCategory(category)).toBe(true);
    }
  });

  it("exposes a Prisma-ready notIn filter that matches the exclusion list", () => {
    expect(OFFERABLE_CATEGORY_FILTER).toEqual([...EXCLUDED_VENUE_CATEGORIES]);
    expect(OFFERABLE_CATEGORY_FILTER).toContain("museum");
  });

  it("treats an unknown category as offerable (only the listed ones are barred)", () => {
    expect(isOfferableVenueCategory("something-new")).toBe(true);
  });
});
