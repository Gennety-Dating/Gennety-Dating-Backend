/**
 * The Places cache's contract, which is a legal one before it is an
 * optimisation: cached provider content may not outlive 30 days.
 *
 * So the cases here are mostly about EXPIRY rather than about hits — a cache
 * that returns a stale row is not a slow cache, it is a terms violation, and it
 * fails silently in exactly the way nobody notices.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findMany = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    placeCache: { findUnique, findMany, upsert, deleteMany },
  },
}));

const {
  PLACE_CACHE_TTL_MS,
  readPlaceCache,
  readPlaceCacheMany,
  writePlaceCache,
  prunePlaceCache,
} = await import("./place-cache.js");

const NOW = Date.parse("2026-09-04T12:00:00Z");

function row(placeId: string, ageMs: number, over: Record<string, unknown> = {}) {
  return {
    placeId,
    name: "Lukianivska",
    address: "Kyiv",
    lat: 50.45,
    lng: 30.52,
    photoRefs: ["places/x/photos/y"],
    refreshedAt: new Date(NOW - ageMs),
    createdAt: new Date(NOW - ageMs),
    ...over,
  };
}

beforeEach(() => {
  findUnique.mockReset();
  findMany.mockReset();
  upsert.mockReset();
  upsert.mockResolvedValue(undefined);
  deleteMany.mockReset();
  deleteMany.mockResolvedValue({ count: 0 });
});

describe("TTL", () => {
  it("caps reuse at Google's 30-day ceiling", () => {
    expect(PLACE_CACHE_TTL_MS).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });

  it("lets a caller read at its OWN, shorter freshness bound", async () => {
    // The row lives 30 days because coordinates do not age. A photo resource
    // name does — it rotates, and a stale one 404s into a category glyph — so
    // the photo reader passes a day and must get a miss on anything older.
    const day = 24 * 60 * 60 * 1000;
    findUnique.mockResolvedValue(row("p1", day + 1000));
    expect(await readPlaceCache("p1", { now: NOW })).not.toBeNull();
    expect(await readPlaceCache("p1", { now: NOW, ttlMs: day })).toBeNull();
  });

  it("hands back refreshedAt so a caller can size its own cache from what is left", async () => {
    const age = 60_000;
    findUnique.mockResolvedValue(row("p1", age));
    const hit = await readPlaceCache("p1", { now: NOW });
    expect(hit?.refreshedAt.getTime()).toBe(NOW - age);
  });

  it("returns a fresh row", async () => {
    findUnique.mockResolvedValue(row("p1", 24 * 60 * 60 * 1000));
    const hit = await readPlaceCache("p1", { now: NOW });
    expect(hit?.lat).toBe(50.45);
  });

  it("treats an expired row as a MISS rather than a stale hit", async () => {
    findUnique.mockResolvedValue(row("p1", PLACE_CACHE_TTL_MS + 1));
    expect(await readPlaceCache("p1", { now: NOW })).toBeNull();
  });

  it("filters expired rows out of a batch read", async () => {
    findMany.mockResolvedValue([
      row("fresh", 1000),
      row("stale", PLACE_CACHE_TTL_MS + 1000),
    ]);
    const map = await readPlaceCacheMany(["fresh", "stale"], { now: NOW });
    expect([...map.keys()]).toEqual(["fresh"]);
  });
});

describe("writes", () => {
  it("touches only the fields it was given, so one path cannot blank another's", async () => {
    // The photo lookup knows refs and nothing else; writing `undefined`
    // coordinates through would erase what `/resolve` stored for the same place.
    await writePlaceCache("p1", { photoRefs: ["places/x/photos/y"] });
    const args = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(Object.keys(args.update).sort()).toEqual(["photoRefs", "refreshedAt"]);
  });

  it("restamps the TTL clock on every write, including a partial one", async () => {
    const now = new Date(NOW);
    await writePlaceCache("p1", { photoRefs: [] }, { now });
    const args = upsert.mock.calls[0][0] as { update: { refreshedAt: Date } };
    expect(args.update.refreshedAt).toBe(now);
  });
});

describe("prune", () => {
  it("deletes by the same cutoff the reads use", async () => {
    deleteMany.mockResolvedValue({ count: 3 });
    expect(await prunePlaceCache({ now: NOW })).toBe(3);
    const args = deleteMany.mock.calls[0][0] as { where: { refreshedAt: { lt: Date } } };
    expect(args.where.refreshedAt.lt.getTime()).toBe(NOW - PLACE_CACHE_TTL_MS);
  });
});

describe("failure policy", () => {
  // A cache is an optimisation; a database hiccup must cost one Google request,
  // never a date. Every entry point therefore degrades instead of throwing.
  it("degrades a failed read to a miss", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await readPlaceCache("p1")).toBeNull();
  });

  it("degrades a failed batch read to an empty map", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    expect((await readPlaceCacheMany(["p1"])).size).toBe(0);
  });

  it("swallows a failed write", async () => {
    upsert.mockRejectedValue(new Error("db down"));
    await expect(writePlaceCache("p1", { lat: 1, lng: 2 })).resolves.toBeUndefined();
  });

  it("reports zero rather than throwing when the prune fails", async () => {
    deleteMany.mockRejectedValue(new Error("db down"));
    expect(await prunePlaceCache()).toBe(0);
  });

  it("never queries for an empty id list", async () => {
    expect((await readPlaceCacheMany([])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
