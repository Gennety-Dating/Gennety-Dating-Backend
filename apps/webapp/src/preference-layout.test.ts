import { describe, expect, it } from "vitest";
import {
  PHOTO_ASPECT,
  SCATTER_SLOTS,
  maxCentreY,
  mirrorScatter,
  placeScatter,
  slotSpanX,
} from "./preference-layout.js";
import type { ScatterSlot } from "./preference-layout.js";
import { orderedAssets } from "./preference-photos.js";

describe("scatter placement", () => {
  it("renders the prefix when there are fewer photos than slots", () => {
    const placed = placeScatter(["a.jpg", "b.jpg"], false);
    expect(placed.map((item) => item.src)).toEqual(["a.jpg", "b.jpg"]);
    expect(placed[0]?.slot).toBe(SCATTER_SLOTS[0]);
    expect(placed[1]?.slot).toBe(SCATTER_SLOTS[1]);
  });

  it("drops the tail when there are more photos than slots", () => {
    const many = Array.from({ length: SCATTER_SLOTS.length + 4 }, (_, i) => `${i}.jpg`);
    expect(placeScatter(many, false)).toHaveLength(SCATTER_SLOTS.length);
  });

  it("is stable — the same photos always land in the same slots", () => {
    const first = placeScatter(["a.jpg", "b.jpg", "c.jpg"], false);
    const second = placeScatter(["a.jpg", "b.jpg", "c.jpg"], false);
    expect(second).toEqual(first);
  });

  it("mirrors x and the tilt, and nothing else", () => {
    const slot = { x: 12, y: 33, w: 50, rot: 7, z: 2 };
    expect(mirrorScatter(slot)).toEqual({ ...slot, x: 88, rot: -7 });
  });

  /**
   * Read from the bottom up the composition is two small, one large, two small,
   * one large-ish — four bands, not six scattered points. The sixth photo is
   * the bottom row's outer tile and must stay LAST, so a five-photo set renders
   * a prefix that leaves that row single rather than half of some other band.
   */
  it("is four bands, and the last slot is the bottom outer corner", () => {
    const bands = [...new Set(SCATTER_SLOTS.map((slot) => Math.round(slot.y / 12)))];
    expect(bands).toHaveLength(4);

    const last = SCATTER_SLOTS[SCATTER_SLOTS.length - 1];
    const lowest = Math.max(...SCATTER_SLOTS.map((slot) => slot.y));
    // In its own band (the lowest one) and on the far side of the column.
    expect(last?.y).toBeGreaterThan(lowest - 6);
    expect(last?.x).toBeGreaterThan(50);
    // Mirrored for women, that same photo lands in the opposite corner.
    expect(mirrorScatter(last as ScatterSlot).x).toBeLessThan(50);
  });

  /**
   * The two columns share a 12px gutter. Every frame that hangs past a column
   * sideways must point AWAY from that gutter once mirroring is applied, or the
   * men's and women's overhangs collide in the middle of the screen.
   *
   * Measured with the tilt included: a rotated tile is wider than its own box,
   * and with full-length photos it is wide enough to matter. Before that was
   * accounted for, the bottom pair of each column reached ~7px into the gutter
   * and the two columns' tiles overlapped there by 2px.
   */
  it("keeps every sideways overhang on the outer edge of its column", () => {
    for (const slot of SCATTER_SLOTS) {
      const { left, right } = slotSpanX(slot);
      // Authored for the LEFT column: it may spill left (outward), and must
      // stay clear of the gutter on the right.
      expect(right).toBeLessThanOrEqual(100);
      // Mirrored for the right column, that spill becomes a right-hand one.
      expect(slotSpanX(mirrorScatter(slot)).left).toBeGreaterThanOrEqual(0);
      // And an overhang worth having is still a frame you can read.
      if (left < 0) expect(left).toBeGreaterThan(-20);
    }
  });

  /**
   * Pins the formula to the rendered page, not to itself. The first version of
   * it used `w/2 + (h/2)·sin` with the height in the wrong unit, which said the
   * outer tiles stopped 21px from the screen edge while the browser put them at
   * 15px — a 6px error, in the one direction that matters.
   */
  it("predicts what the browser actually renders", () => {
    // The men's upper-left tile at 390×844: column starts at x=24 and is 165
    // wide, and the browser reports this tile's left edge at 15px.
    const outer = SCATTER_SLOTS[2] as ScatterSlot;
    const leftPx = 24 + (slotSpanX(outer).left / 100) * 165;
    expect(leftPx).toBeGreaterThan(13);
    expect(leftPx).toBeLessThan(18);
  });

  it("accounts for the tilt when measuring a tile's width", () => {
    const upright = slotSpanX({ x: 50, y: 50, w: 40, rot: 0, z: 1 });
    expect(upright).toEqual({ left: 30, right: 70 });
    // The same tile turned reaches wider on BOTH sides, by the same amount.
    const tilted = slotSpanX({ x: 50, y: 50, w: 40, rot: 9, z: 1 });
    expect(tilted.left).toBeLessThan(30);
    expect(tilted.right).toBeGreaterThan(70);
    expect(30 - tilted.left).toBeCloseTo(tilted.right - 70, 6);
  });

  /**
   * The label owns the bottom strip of the button, and the photo area stops
   * where it begins — so a tile crossing y = 100 lands on the word the button
   * is asking about. The bottom pair used to sit at 84/82, which did exactly
   * that on every screen.
   *
   * Checked at the TIGHTEST column, because that is the failing direction and
   * not the obvious one: tiles are sized from the area's width, so the shorter
   * the column, the more of its height each one eats. A y that clears the floor
   * on a 390×844 phone can still run through it on a 320×568 one.
   */
  it("keeps every frame off the label, at the tightest column", () => {
    for (const slot of SCATTER_SLOTS) {
      expect(slot.y).toBeLessThanOrEqual(maxCentreY(slot));
    }
  });

  it("measures a tile's vertical reach with the tilt included", () => {
    // A square-ish area: the tile's own height is then w/0.5625 of it, so an
    // untilted 40-wide tile spans 71.1 and its centre may sit at 100 - 35.6.
    const upright = maxCentreY({ x: 50, y: 0, w: 40, rot: 0, z: 1 }, 1);
    expect(upright).toBeCloseTo(100 - 40 / PHOTO_ASPECT / 2, 6);
    // Turned, it reaches lower and must sit higher.
    expect(maxCentreY({ x: 50, y: 0, w: 40, rot: 9, z: 1 }, 1)).toBeLessThan(upright);
    // And a taller area leaves more room under the same tile.
    expect(maxCentreY({ x: 50, y: 0, w: 40, rot: 0, z: 1 }, 3)).toBeGreaterThan(upright);
  });

  it("keeps every frame's centre inside the column", () => {
    for (const slot of SCATTER_SLOTS) {
      expect(slot.x).toBeGreaterThan(0);
      expect(slot.x).toBeLessThan(100);
    }
  });
});

describe("photo sets", () => {
  it("falls back to the demo deck while a folder is empty", () => {
    expect(orderedAssets({}, ["/profiles/1.jpg"])).toEqual(["/profiles/1.jpg"]);
  });

  it("orders by path, not by whatever order the glob returned", () => {
    expect(
      orderedAssets({ "./b.jpg": "/b-hash.jpg", "./a.jpg": "/a-hash.jpg" }, ["fallback"]),
    ).toEqual(["/a-hash.jpg", "/b-hash.jpg"]);
  });
});

