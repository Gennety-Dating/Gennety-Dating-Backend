import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const scratchFindUnique = vi.fn();
const scratchUpsert = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    userScratchMap: { findUnique: scratchFindUnique, upsert: scratchUpsert },
  },
}));

const { DEFAULT_MARKET, tileFor } = await import("@gennety/shared");
const {
  addTile,
  percentFor,
  recordScratchPing,
  recordVerifiedVisit,
  tilesInMarket,
} = await import("./scratch-map.js");

// Kyiv's centre and a point in Podil, ~4 km apart — different tiles.
const CENTRE = { lat: 50.4501, lng: 30.5234 };
const PODIL = { lat: 50.4645, lng: 30.5164 };

function optedIn(over: Record<string, unknown> = {}) {
  return { scratchMapOptIn: true, profile: { homeCityKey: "ua:kyiv" }, ...over };
}

beforeEach(() => {
  userFindUnique.mockReset().mockResolvedValue(optedIn());
  scratchFindUnique.mockReset().mockResolvedValue(null);
  scratchUpsert.mockReset().mockImplementation(({ create, update }: any) =>
    Promise.resolve({
      exploredTiles: update?.exploredTiles ?? create.exploredTiles,
      exploredPercent: update?.exploredPercent ?? create.exploredPercent,
      discoveredVenues: update?.discoveredVenues ?? create.discoveredVenues ?? [],
    }),
  );
});

describe("tilesInMarket", () => {
  // The denominator has to describe the CITY, not the data: derived from
  // visited tiles it would move everyone's percentage whenever a stranger
  // walked somewhere new.
  it("counts a city's worth of tiles, matching its own area", () => {
    const tiles = tilesInMarket(DEFAULT_MARKET);
    // A geohash-6 cell at Kyiv's latitude is ~0.611 km × ~0.778 km.
    const areaKm2 = tiles * 0.611 * 0.778;
    const circleKm2 = Math.PI * DEFAULT_MARKET.radiusKm ** 2;
    expect(areaKm2 / circleKm2).toBeGreaterThan(0.95);
    expect(areaKm2 / circleKm2).toBeLessThan(1.05);
  });

  it("is stable across calls", () => {
    expect(tilesInMarket(DEFAULT_MARKET)).toBe(tilesInMarket(DEFAULT_MARKET));
  });
});

describe("percentFor", () => {
  it("is a fraction of the city, and never above one", () => {
    expect(percentFor([], DEFAULT_MARKET)).toBe(0);
    expect(percentFor(["a"], DEFAULT_MARKET)).toBeGreaterThan(0);
    expect(percentFor(["a"], DEFAULT_MARKET)).toBeLessThan(0.01);

    const everywhere = Array.from({ length: tilesInMarket(DEFAULT_MARKET) * 2 }, (_, i) => `t${i}`);
    expect(percentFor(everywhere, DEFAULT_MARKET)).toBe(1);
  });
});

describe("addTile", () => {
  // Postgres arrays enforce neither uniqueness nor order, and a duplicate
  // would silently inflate the one number on the row a person reads.
  it("keeps the set unique and sorted", () => {
    expect(addTile(["b", "a"], "c")).toEqual(["a", "b", "c"]);
    expect(addTile(["a", "b"], "a")).toEqual(["a", "b"]);
  });
});

describe("recordScratchPing", () => {
  it("refuses without the opt-in, and writes nothing", async () => {
    userFindUnique.mockResolvedValue(optedIn({ scratchMapOptIn: false }));

    const result = await recordScratchPing({ userId: "u1", ...CENTRE });

    expect(result).toEqual({ refused: "opted-out" });
    expect(scratchUpsert).not.toHaveBeenCalled();
  });

  it("refuses coordinates that are not on Earth", async () => {
    const result = await recordScratchPing({ userId: "u1", lat: 500, lng: 30 });
    expect(result).toEqual({ refused: "bad-coordinates" });
    expect(scratchUpsert).not.toHaveBeenCalled();
  });

  // The map is "your Kyiv": a week in Berlin would otherwise fill it with
  // squares no percentage of Kyiv can describe.
  it("refuses a ping from outside the user's own market", async () => {
    const result = await recordScratchPing({ userId: "u1", lat: 52.52, lng: 13.405 });
    expect(result).toEqual({ refused: "outside-market" });
    expect(scratchUpsert).not.toHaveBeenCalled();
  });

  it("uncovers a tile and reports the new percentage", async () => {
    const result = await recordScratchPing({ userId: "u1", ...CENTRE });

    expect(result).toMatchObject({ uncovered: true });
    const written = scratchUpsert.mock.calls[0]![0].create;
    expect(written.exploredTiles).toEqual([tileFor(CENTRE.lat, CENTRE.lng)]);
    expect(written.exploredPercent).toBeGreaterThan(0);
  });

  // The common case by far — the canvas pings while someone sits still — so
  // it must cost one read and no write.
  it("writes nothing when the ground is already uncovered", async () => {
    scratchFindUnique.mockResolvedValue({
      exploredTiles: [tileFor(CENTRE.lat, CENTRE.lng)],
      exploredPercent: 0.001,
      discoveredVenues: [],
    });

    const result = await recordScratchPing({ userId: "u1", ...CENTRE });

    expect(result).toMatchObject({ uncovered: false });
    expect(scratchUpsert).not.toHaveBeenCalled();
  });

  // The one thing this endpoint must never do, asserted on what reaches the
  // database rather than only on what the service returns.
  it("stores a tile and never the coordinates it came from", async () => {
    await recordScratchPing({ userId: "u1", ...PODIL });

    const wire = JSON.stringify(scratchUpsert.mock.calls[0]![0]);
    expect(wire).not.toContain(String(PODIL.lat));
    expect(wire).not.toContain(String(PODIL.lng));
    expect(wire).toContain(tileFor(PODIL.lat, PODIL.lng)!);
  });
});

describe("recordVerifiedVisit", () => {
  it("gives both sides the venue and its tile", async () => {
    await recordVerifiedVisit({
      userIds: ["a", "b"],
      venueId: "venue-1",
      lat: CENTRE.lat,
      lng: CENTRE.lng,
    });

    expect(scratchUpsert).toHaveBeenCalledTimes(2);
    const first = scratchUpsert.mock.calls[0]![0].create;
    expect(first.discoveredVenues).toEqual(["venue-1"]);
    expect(first.exploredTiles).toEqual([tileFor(CENTRE.lat, CENTRE.lng)]);
  });

  it("still honours the opt-in", async () => {
    userFindUnique.mockResolvedValue(optedIn({ scratchMapOptIn: false }));

    await recordVerifiedVisit({ userIds: ["a"], venueId: "v", lat: CENTRE.lat, lng: CENTRE.lng });

    expect(scratchUpsert).not.toHaveBeenCalled();
  });

  // It rides the bump's own success path, and a scratch map that misses a
  // square must never cost someone the date their reliability and bonus
  // ticket depend on.
  it("swallows its own failure rather than failing the bump", async () => {
    scratchUpsert.mockRejectedValue(new Error("db down"));

    await expect(
      recordVerifiedVisit({ userIds: ["a"], venueId: "v", lat: CENTRE.lat, lng: CENTRE.lng }),
    ).resolves.toBeUndefined();
  });

  it("does not write a venue twice", async () => {
    scratchFindUnique.mockResolvedValue({
      exploredTiles: [tileFor(CENTRE.lat, CENTRE.lng)],
      exploredPercent: 0.001,
      discoveredVenues: ["venue-1"],
    });

    await recordVerifiedVisit({
      userIds: ["a"],
      venueId: "venue-1",
      lat: CENTRE.lat,
      lng: CENTRE.lng,
    });

    expect(scratchUpsert).not.toHaveBeenCalled();
  });

  // A venue with no stored coordinates is a real row shape; the visit must
  // still count the place even when it cannot count the ground.
  it("records the venue when the coordinates are missing", async () => {
    await recordVerifiedVisit({ userIds: ["a"], venueId: "venue-1", lat: null, lng: null });

    const written = scratchUpsert.mock.calls[0]![0].create;
    expect(written.discoveredVenues).toEqual(["venue-1"]);
    expect(written.exploredTiles).toEqual([]);
  });
});
