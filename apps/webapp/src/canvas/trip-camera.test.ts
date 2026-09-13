import { describe, expect, it } from "vitest";

import { fromWorld, toWorld, tripCamera, type TripCameraInput } from "./trip-camera.js";

const VENUE = { lat: 50.448, lng: 30.52 };

function input(overrides: Partial<TripCameraInput> = {}): TripCameraInput {
  return {
    from: { lat: 50.4655, lng: 30.501 },
    to: VENUE,
    width: 390,
    height: 844,
    cover: { top: 0, right: 0, bottom: 300, left: 0 },
    margin: { top: 72, right: 56, bottom: 56, left: 56 },
    maxZoom: 16,
    ...overrides,
  };
}

/**
 * Where a point lands on screen under the camera, the way MapLibre draws it:
 * the camera's centre at the centre of the area the padding leaves.
 */
function screen(opts: TripCameraInput, lat: number, lng: number) {
  const camera = tripCamera(opts)!;
  const scale = 512 * 2 ** camera.zoom;
  const c = toWorld(camera.lat, camera.lng);
  const p = toWorld(lat, lng);
  const cx = opts.cover.left + (opts.width - opts.cover.left - opts.cover.right) / 2;
  const cy = opts.cover.top + (opts.height - opts.cover.top - opts.cover.bottom) / 2;
  return { x: cx + (p.x - c.x) * scale, y: cy + (p.y - c.y) * scale };
}

describe("mercator", () => {
  it("round-trips a coordinate", () => {
    const back = fromWorld(toWorld(VENUE.lat, VENUE.lng).x, toWorld(VENUE.lat, VENUE.lng).y);
    expect(back.lat).toBeCloseTo(VENUE.lat, 10);
    expect(back.lng).toBeCloseTo(VENUE.lng, 10);
  });

  it("puts the equator and the antimeridian where MapLibre does", () => {
    expect(toWorld(0, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect(toWorld(0, -180).x).toBe(0);
    // North is up: a northern latitude has the smaller y.
    expect(toWorld(50, 0).y).toBeLessThan(0.5);
  });
});

describe("tripCamera", () => {
  it("fits a wide trip edge to edge inside the margins", () => {
    // 2.4 km, mostly east-west on a narrow phone: the width is what binds.
    const opts = input();
    const me = screen(opts, opts.from.lat, opts.from.lng);
    const venue = screen(opts, VENUE.lat, VENUE.lng);
    expect(Math.min(me.x, venue.x)).toBeCloseTo(56, 6);
    expect(Math.max(me.x, venue.x)).toBeCloseTo(390 - 56, 6);
    for (const p of [me, venue]) {
      expect(p.y).toBeGreaterThanOrEqual(72 - 1e-6);
      // Never under the dock: what it covers plus the pins' own room.
      expect(p.y).toBeLessThanOrEqual(844 - 300 - 56 + 1e-6);
    }
  });

  it("fits a tall trip top to the dock's edge", () => {
    const opts = input({ from: { lat: 50.49, lng: 30.521 } });
    const me = screen(opts, opts.from.lat, opts.from.lng);
    const venue = screen(opts, VENUE.lat, VENUE.lng);
    expect(me.y).toBeCloseTo(72, 6);
    expect(venue.y).toBeCloseTo(844 - 300 - 56, 6);
    expect(me.x).toBeGreaterThan(56);
    expect(venue.x).toBeLessThan(390 - 56);
  });

  it("counts the dock once", () => {
    // The defect this replaces: the cover went in as the fit's padding AND
    // stood on the camera, so a tall dock left no room and the fit gave up.
    const opts = input({ from: { lat: 50.49, lng: 30.521 }, cover: { top: 0, right: 0, bottom: 380, left: 0 } });
    expect(tripCamera(opts)).not.toBeNull();
    expect(screen(opts, VENUE.lat, VENUE.lng).y).toBeCloseTo(844 - 380 - 56, 6);
  });

  it("stops at the venue's zoom for two points a street apart", () => {
    const opts = input({ from: { lat: 50.4481, lng: 30.5201 } });
    const camera = tripCamera(opts)!;
    expect(camera.zoom).toBe(16);
    // Still centred in the box, not merely clamped.
    const me = screen(opts, opts.from.lat, opts.from.lng);
    const venue = screen(opts, VENUE.lat, VENUE.lng);
    expect((me.x + venue.x) / 2).toBeCloseTo(56 + (390 - 112) / 2, 6);
    expect((me.y + venue.y) / 2).toBeCloseTo(72 + (844 - 300 - 128) / 2, 6);
  });

  it("frames a user standing at the venue on the venue", () => {
    const camera = tripCamera(input({ from: VENUE }))!;
    expect(camera.zoom).toBe(16);
    expect(Number.isFinite(camera.lat) && Number.isFinite(camera.lng)).toBe(true);
  });

  it("is the same camera whichever end is which", () => {
    const there = tripCamera(input())!;
    const back = tripCamera(input({ from: VENUE, to: input().from }))!;
    expect(back.lat).toBeCloseTo(there.lat, 12);
    expect(back.lng).toBeCloseTo(there.lng, 12);
    expect(back.zoom).toBeCloseTo(there.zoom, 12);
  });

  it("declines when the cover leaves no room", () => {
    expect(tripCamera(input({ cover: { top: 0, right: 0, bottom: 800, left: 0 } }))).toBeNull();
    expect(tripCamera(input({ width: 100 }))).toBeNull();
  });
});
