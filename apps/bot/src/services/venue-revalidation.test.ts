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
