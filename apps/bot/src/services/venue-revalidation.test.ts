import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    curatedVenue: {
      findMany: vi.fn(),
      // `update` is kept in the mock deliberately, even though nothing calls it
      // any more: a regression back to per-row writes would then show up as a
      // failed assertion ("never falls back to a per-row update") rather than as
      // a bare TypeError with no explanation.
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 5 }),
    },
  },
  Prisma: { JsonNull: "JsonNull" },
}));

import { prisma } from "@gennety/db";
import { SUPPORTED_CITY_KEYS } from "@gennety/shared";
import {
  venueRevalidationTick,
  selectStalestPlaces,
  CURATED_PHOTO_REFS_MAX,
  DEFAULT_VENUE_REVALIDATION_BATCH,
} from "./venue-revalidation.js";
import type { PlaceDetails } from "./venue.js";

type MockFn = ReturnType<typeof vi.fn>;
const mFindMany = (prisma.curatedVenue as unknown as { findMany: MockFn }).findMany;
const mUpdate = (prisma.curatedVenue as unknown as { update: MockFn }).update;
const mUpdateMany = (prisma.curatedVenue as unknown as { updateMany: MockFn })
  .updateMany;

/** N per-`universityDomain` copies of one real venue, as the seeder writes them. */
function copies(
  placeId: string,
  name: string,
  count: number,
  lastVerifiedAt?: Date | null,
) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${placeId}-copy-${i}`,
    placeId,
    name,
    lastVerifiedAt: lastVerifiedAt ?? null,
  }));
}

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
    photoRefs: ["places/p1/photos/a", "places/p1/photos/b"],
    ...overrides,
  };
}

describe("venueRevalidationTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mUpdate.mockResolvedValue({});
    mUpdateMany.mockResolvedValue({ count: 5 });
    // `config.ts` loads the developer's own `.env` in this suite, so an operator
    // override must not leak into the batch-size cases below.
    delete process.env.VENUE_REVALIDATION_BATCH_SIZE;
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
    expect(mUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { placeId: "p1" },
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
    expect(mUpdateMany).toHaveBeenCalledWith(
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
    const arg = mUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
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
    const arg = mUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
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
    const arg = mUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect("priceLevel" in arg.data).toBe(false);
    expect("primaryType" in arg.data).toBe(false);
    expect("editorialSummary" in arg.data).toBe(false);
    // The hours refresh still happens — those are always written.
    expect(arg.data.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("stores the venue's photo refs, capped, so the board never has to look them up", async () => {
    mFindMany.mockResolvedValue([{ id: "v7", placeId: "p7", name: "Photogenic" }]);
    const many = Array.from({ length: 14 }, (_, i) => `places/p7/photos/${i}`);
    await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => details({ photoRefs: many }),
    });
    const arg = mUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.photoRefs).toEqual(many.slice(0, CURATED_PHOTO_REFS_MAX));
    // Google's own order is the cover-first order the board renders.
    expect((arg.data.photoRefs as string[])[0]).toBe("places/p7/photos/0");
  });

  it("does NOT erase stored photo refs when Places answers with none", async () => {
    // The one that actually bites. An absent `photos` field is indistinguishable
    // from a partial 200, so writing an empty array through would blank the
    // venue on the board until its next scan — ~9 days for a full Kyiv cycle,
    // against the 5 minutes the old in-process cache held an empty answer for.
    mFindMany.mockResolvedValue([{ id: "v8", placeId: "p8", name: "Sparse Photos" }]);
    await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => details({ photoRefs: [] }),
    });
    const arg = mUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect("photoRefs" in arg.data).toBe(false);
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
    expect(mUpdateMany).not.toHaveBeenCalled();
  });

  it("scans launched markets only, reading the shared constant", async () => {
    // The nine tests above cannot catch a wrong market filter: `findMany` is
    // mocked and their fixtures carry no `cityKey`. This is that coverage hole.
    // Asserted against the imported constant rather than the literal "ua:kyiv"
    // so that launching a market propagates instead of failing here.
    mFindMany.mockResolvedValue([]);
    await venueRevalidationTick({ apiKey: "k", fetchDetails: async () => details() });
    const where = (mFindMany.mock.calls[0]![0] as { where: Record<string, unknown> })
      .where;
    expect(where.cityKey).toEqual({ in: [...SUPPORTED_CITY_KEYS] });
  });

  it("spends ONE Places request per distinct place, not per domain copy", async () => {
    // The whole fix. The seeder stores one row per `universityDomain`, so this
    // is what a single real venue looks like in the table.
    mFindMany.mockResolvedValue(copies("p1", "Five Copies", 5));
    let fetches = 0;
    const res = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => {
        fetches++;
        return details();
      },
    });
    expect(fetches).toBe(1);
    expect(res.scanned).toBe(1);
    expect(mUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("settles every copy in one write, and never falls back to a per-row update", async () => {
    mFindMany.mockResolvedValue(copies("p9", "Healthy", 5));
    await venueRevalidationTick({ apiKey: "k", fetchDetails: async () => details() });
    const arg = mUpdateMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(arg.where).toEqual({ placeId: "p9" });
    expect("id" in arg.where).toBe(false);
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it("counts PLACES, not rows, so scanned is the night's Places spend", async () => {
    mFindMany.mockResolvedValue([
      ...copies("dead", "Closed Place", 3),
      ...copies("live", "Open Place", 3),
    ]);
    const res = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async (_key, placeId) =>
        placeId === "dead"
          ? details({ businessStatus: "CLOSED_PERMANENTLY" })
          : details(),
    });
    expect(res).toEqual({ scanned: 2, deactivated: 1, refreshed: 1, failed: 0 });
  });

  it("counts an infra failure once per place, and writes nothing for it", async () => {
    mFindMany.mockResolvedValue(copies("p10", "Flaky", 5));
    const res = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => {
        throw new Error("503 from Places");
      },
    });
    expect(res.failed).toBe(1); // not 5
    expect(mUpdateMany).not.toHaveBeenCalled();
  });

  it("takes the batch size from env, and lets an explicit option win", async () => {
    const many = Array.from({ length: 5 }, (_, i) => copies(`p${i}`, `V${i}`, 2)).flat();
    mFindMany.mockResolvedValue(many);

    process.env.VENUE_REVALIDATION_BATCH_SIZE = "2";
    const fromEnv = await venueRevalidationTick({
      apiKey: "k",
      fetchDetails: async () => details(),
    });
    expect(fromEnv.scanned).toBe(2);

    const fromOption = await venueRevalidationTick({
      apiKey: "k",
      batchSize: 1,
      fetchDetails: async () => details(),
    });
    expect(fromOption.scanned).toBe(1);
  });

  it("falls back to the default on a junk batch size instead of scanning nothing", async () => {
    // The trap this replaces: under the old row-based code a junk value became
    // `take: NaN` and Prisma threw loudly. Under `.slice(0, NaN)` it would
    // silently return [] — a cron that scans nothing, every night, forever.
    const many = Array.from({ length: DEFAULT_VENUE_REVALIDATION_BATCH + 5 }, (_, i) =>
      copies(`p${i}`, `V${i}`, 2),
    ).flat();
    for (const junk of ["abc", "0", "-5"]) {
      vi.clearAllMocks();
      mUpdateMany.mockResolvedValue({ count: 2 });
      mFindMany.mockResolvedValue(many);
      process.env.VENUE_REVALIDATION_BATCH_SIZE = junk;
      const res = await venueRevalidationTick({
        apiKey: "k",
        fetchDetails: async () => details(),
      });
      expect(res.scanned).toBe(DEFAULT_VENUE_REVALIDATION_BATCH);
    }
  });
});

describe("selectStalestPlaces", () => {
  const at = (iso: string) => new Date(iso);

  it("collapses every copy of a place to one target", () => {
    const targets = selectStalestPlaces(copies("p1", "Five Copies", 5), 10);
    expect(targets).toEqual([{ placeId: "p1", name: "Five Copies" }]);
  });

  it("orders places by their OLDEST copy, not their newest", () => {
    // With the newest, a copy lagging behind its siblings would look fresh
    // forever and never be revisited.
    const rows = [
      { placeId: "a", name: "A", lastVerifiedAt: at("2026-01-01") },
      { placeId: "a", name: "A", lastVerifiedAt: at("2026-09-01") },
      { placeId: "b", name: "B", lastVerifiedAt: at("2026-05-01") },
      { placeId: "b", name: "B", lastVerifiedAt: at("2026-05-01") },
    ];
    expect(selectStalestPlaces(rows, 10).map((t) => t.placeId)).toEqual(["a", "b"]);
  });

  it("puts a never-verified place ahead of every dated one", () => {
    // The reason `groupBy` was rejected: Postgres orders `min(...)` NULLS LAST,
    // so these places would have queued dead last, permanently.
    const rows = [
      { placeId: "dated", name: "Dated", lastVerifiedAt: at("2020-01-01") },
      { placeId: "fresh", name: "Fresh", lastVerifiedAt: at("2026-08-01") },
      { placeId: "never", name: "Never", lastVerifiedAt: null },
    ];
    expect(selectStalestPlaces(rows, 10).map((t) => t.placeId)).toEqual([
      "never",
      "dated",
      "fresh",
    ]);
  });

  it("treats one never-verified copy as making the whole place never-verified", () => {
    const rows = [
      { placeId: "a", name: "A", lastVerifiedAt: at("2020-01-01") },
      { placeId: "b", name: "B", lastVerifiedAt: at("2019-01-01") },
      { placeId: "b", name: "B", lastVerifiedAt: null },
    ];
    expect(selectStalestPlaces(rows, 1).map((t) => t.placeId)).toEqual(["b"]);
  });

  it("skips rows with no placeId rather than bucketing them together", () => {
    const rows = [
      { placeId: null, name: "Hand-entered" },
      { placeId: null, name: "Also hand-entered" },
      { placeId: "p1", name: "Real" },
    ];
    expect(selectStalestPlaces(rows, 10)).toEqual([{ placeId: "p1", name: "Real" }]);
  });

  it("applies the limit to PLACES after dedupe, not to rows before it", () => {
    const rows = [
      ...copies("a", "A", 5, at("2020-01-01")),
      ...copies("b", "B", 5, at("2021-01-01")),
      ...copies("c", "C", 5, at("2022-01-01")),
    ];
    expect(selectStalestPlaces(rows, 2).map((t) => t.placeId)).toEqual(["a", "b"]);
  });

  it("is deterministic when staleness ties, whatever order the rows arrive in", () => {
    // Copies are stamped together, so exact ties are the norm, not an edge case.
    // Without the placeId tie-break the batch is whatever Postgres returned —
    // unreproducible, and unassertable. Both keys here are -Infinity, which is
    // also what makes `a.key - b.key` (NaN) the wrong comparator.
    const rows = [
      { placeId: "c", name: "C", lastVerifiedAt: null },
      { placeId: "a", name: "A", lastVerifiedAt: null },
      { placeId: "b", name: "B", lastVerifiedAt: null },
    ];
    expect(selectStalestPlaces(rows, 3).map((t) => t.placeId)).toEqual(["a", "b", "c"]);
    expect(selectStalestPlaces([...rows].reverse(), 3).map((t) => t.placeId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(selectStalestPlaces(copies("p1", "X", 3), 0)).toEqual([]);
  });
});
