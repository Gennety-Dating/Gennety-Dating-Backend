import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    curatedVenue: {
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
  Prisma: { JsonNull: "JsonNull" },
}));

import { prisma } from "@gennety/db";
import { venueRevalidationTick } from "./venue-revalidation.js";
import type { PlaceDetails } from "./venue.js";

type MockFn = ReturnType<typeof vi.fn>;
const mFindMany = (prisma.curatedVenue as unknown as { findMany: MockFn }).findMany;
const mUpdate = (prisma.curatedVenue as unknown as { update: MockFn }).update;

function details(overrides: Partial<PlaceDetails> = {}): PlaceDetails {
  return {
    placeId: "p1",
    businessStatus: "OPERATIONAL",
    rating: 4.6,
    userRatingCount: 200,
    openingHours: { periods: [{ open: { day: 1, hour: 9 }, close: { day: 1, hour: 22 } }] },
    utcOffsetMinutes: 180,
    priceLevel: "PRICE_LEVEL_MODERATE",
    primaryType: "cafe",
    editorialSummary: "A cosy neighbourhood cafe.",
    ...overrides,
  };
}

describe("venueRevalidationTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mUpdate.mockResolvedValue({});
  });

  it("returns zeros and does not query when no API key is available", async () => {
    const res = await venueRevalidationTick({ apiKey: "" });
    expect(res).toEqual({ scanned: 0, deactivated: 0, refreshed: 0, failed: 0 });
    expect(mFindMany).not.toHaveBeenCalled();
  });

  it("deactivates a venue that is no longer OPERATIONAL", async () => {
    mFindMany.mockResolvedValue([{ id: "v1", placeId: "p1", name: "Dead Cafe" }]);
    const res = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => details({ businessStatus: "CLOSED_PERMANENTLY" }),
    });
    expect(res.deactivated).toBe(1);
    expect(res.refreshed).toBe(0);
    expect(mUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "v1" },
        data: expect.objectContaining({ active: false }),
      }),
    );
  });

  it("deactivates a venue whose rating dropped below the floor", async () => {
    mFindMany.mockResolvedValue([{ id: "v2", placeId: "p2", name: "Slipping Cafe" }]);
    const res = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => details({ rating: 3.4 }),
    });
    expect(res.deactivated).toBe(1);
    expect(mUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ active: false }) }),
    );
  });

  it("refreshes hours + lastVerifiedAt on a healthy venue without deactivating", async () => {
    mFindMany.mockResolvedValue([{ id: "v3", placeId: "p3", name: "Good Cafe" }]);
    const res = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => details({ utcOffsetMinutes: 120 }),
    });
    expect(res.refreshed).toBe(1);
    expect(res.deactivated).toBe(0);
    const arg = mUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.active).toBeUndefined(); // never touches `active` on a healthy row
    expect(arg.data.utcOffsetMinutes).toBe(120);
    expect(arg.data.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("persists the quality/price metadata the V2 eligibility gate reads", async () => {
    // Regression: the tick used to read `rating`/`priceLevel` for its fitness
    // check and then write back only the hours, so a row seeded before those
    // columns existed kept a null `priceLevel` forever and was permanently
    // rejected as `unknown_price`. The cron could not heal what it exists for.
    mFindMany.mockResolvedValue([{ id: "v5", placeId: "p5", name: "Stale Row" }]);
    const res = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () =>
        details({
          rating: 4.4,
          userRatingCount: 812,
          priceLevel: "PRICE_LEVEL_INEXPENSIVE",
          primaryType: "coffee_shop",
          editorialSummary: "Specialty roaster.",
        }),
    });
    expect(res.refreshed).toBe(1);
    const arg = mUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.rating).toBe(4.4);
    expect(arg.data.userRatingCount).toBe(812);
    expect(arg.data.priceLevel).toBe("PRICE_LEVEL_INEXPENSIVE");
    expect(arg.data.primaryType).toBe("coffee_shop");
    expect(arg.data.editorialSummary).toBe("Specialty roaster.");
  });

  it("leaves a stored value alone when Places omits that field", async () => {
    // A field absent from a Places response is "unknown", not "now empty".
    // Writing null would erase good data — and for `priceLevel` that alone
    // drops the venue out of the pool.
    mFindMany.mockResolvedValue([{ id: "v6", placeId: "p6", name: "Sparse Response" }]);
    await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () =>
        details({ priceLevel: null, primaryType: null, editorialSummary: null }),
    });
    const arg = mUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect("priceLevel" in arg.data).toBe(false);
    expect("primaryType" in arg.data).toBe(false);
    expect("editorialSummary" in arg.data).toBe(false);
    // The hours refresh still happens — those are always written.
    expect(arg.data.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("does NOT deactivate on an infra failure — counts it as failed and retries later", async () => {
    mFindMany.mockResolvedValue([{ id: "v4", placeId: "p4", name: "Flaky Fetch" }]);
    const res = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => {
        throw new Error("503 from Places");
      },
    });
    expect(res.failed).toBe(1);
    expect(res.deactivated).toBe(0);
    expect(mUpdate).not.toHaveBeenCalled();
  });
});
