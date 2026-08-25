import { describe, expect, it } from "vitest";

import { SCRATCH_TILE_PRECISION } from "./date-lifecycle.js";
import { isTile, tileBounds, tileFor } from "./geohash.js";

describe("tileFor", () => {
  // Pinned against a value produced by an independent implementation, not by
  // this one: a self-consistent encoder that agrees with nobody would still
  // pass every round-trip test in this file.
  it("matches the standard geohash alphabet and interleave", () => {
    expect(tileFor(57.64911, 10.40744)).toBe("u4pruy");
    expect(tileFor(0, 0)).toBe("s00000");
    expect(tileFor(-90, -180)).toBe("000000");
  });

  it("answers at exactly the scratch map's resolution", () => {
    expect(tileFor(50.4501, 30.5234)).toHaveLength(SCRATCH_TILE_PRECISION);
  });

  // The whole point of the module: a tile names a neighbourhood, and two
  // points a few hundred metres apart are indistinguishable in it.
  it("cannot tell two nearby points apart", () => {
    const centre = tileFor(50.4501, 30.5234);
    // ~150 m north and ~200 m east of the same square in Kyiv.
    expect(tileFor(50.4515, 30.5262)).toBe(centre);
  });

  it("does tell neighbourhoods apart", () => {
    const podil = tileFor(50.4645, 30.5164);
    const pechersk = tileFor(50.4265, 30.5384);
    expect(podil).not.toBe(pechersk);
  });

  // A client that sends latitude 500 has a bug; clamping would put a tile on
  // someone's map that they never stood in.
  it("refuses coordinates that are not on Earth", () => {
    expect(tileFor(500, 30)).toBeNull();
    expect(tileFor(50, 500)).toBeNull();
    expect(tileFor(Number.NaN, 30)).toBeNull();
    expect(tileFor(50, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("tileBounds", () => {
  it("contains the point it was encoded from", () => {
    const lat = 50.4501;
    const lng = 30.5234;
    const bounds = tileBounds(tileFor(lat, lng)!)!;

    expect(lat).toBeGreaterThanOrEqual(bounds.minLat);
    expect(lat).toBeLessThanOrEqual(bounds.maxLat);
    expect(lng).toBeGreaterThanOrEqual(bounds.minLng);
    expect(lng).toBeLessThanOrEqual(bounds.maxLng);
  });

  // ~1.2 km × 0.61 km is the claim the privacy note in the schema makes, so it
  // is worth asserting rather than trusting: a precision that silently became
  // 7 would narrow a tile to a city block.
  it("covers roughly a neighbourhood, not a building", () => {
    const bounds = tileBounds(tileFor(50.4501, 30.5234)!)!;
    const heightKm = (bounds.maxLat - bounds.minLat) * 111.32;
    const widthKm =
      (bounds.maxLng - bounds.minLng) * 111.32 * Math.cos((50.45 * Math.PI) / 180);

    expect(heightKm).toBeGreaterThan(0.5);
    expect(heightKm).toBeLessThan(0.8);
    expect(widthKm).toBeGreaterThan(0.6);
    expect(widthKm).toBeLessThan(1.0);
  });

  // The webapp keeps its own copy of this decode (it deliberately does not
  // depend on this package — `apps/webapp/src/canvas/fog.ts`), so these four
  // numbers are asserted verbatim on BOTH sides. That is the whole guard
  // against the two drifting apart unnoticed.
  it("decodes the reference vector to the box the webapp also expects", () => {
    const bounds = tileBounds("u4pruy")!;
    expect(bounds.minLat).toBeCloseTo(57.645263671875, 9);
    expect(bounds.maxLat).toBeCloseTo(57.6507568359375, 9);
    expect(bounds.minLng).toBeCloseTo(10.404052734375, 9);
    expect(bounds.maxLng).toBeCloseTo(10.4150390625, 9);
  });

  it("refuses anything that is not one of our tiles", () => {
    expect(tileBounds("u4pru")).toBeNull();
    expect(tileBounds("u4pruy1")).toBeNull();
    // `a`, `i`, `l` and `o` are excluded from the alphabet on purpose.
    expect(tileBounds("u4prua")).toBeNull();
  });
});

describe("isTile", () => {
  it("accepts what tileFor produces and nothing else", () => {
    expect(isTile(tileFor(50.4501, 30.5234)!)).toBe(true);
    expect(isTile("u4pru")).toBe(false);
    expect(isTile("u4pruy1")).toBe(false);
    expect(isTile("u4prAy")).toBe(false);
    expect(isTile("")).toBe(false);
  });
});
