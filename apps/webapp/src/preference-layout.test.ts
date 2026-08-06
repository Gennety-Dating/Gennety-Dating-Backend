import { describe, expect, it } from "vitest";
import {
  CLUSTER_SLOTS,
  SCATTER_SLOTS,
  mirrorScatter,
  placeCluster,
  placeScatter,
} from "./preference-layout.js";
import { orderedAssets } from "./preference-photos.js";
import { otherVariantHref, parseVariant, preferenceVariant } from "./preference-variant.js";

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
    const slot = { x: 12, y: 33, w: 50, rot: 7, opacity: 0.5, z: 2 };
    expect(mirrorScatter(slot)).toEqual({ ...slot, x: 88, rot: -7 });
  });

  /**
   * The two columns share a 12px gutter. Every frame that hangs past a column
   * sideways must point AWAY from that gutter once mirroring is applied, or the
   * men's and women's overhangs collide in the middle of the screen.
   */
  it("keeps every sideways overhang on the outer edge of its column", () => {
    for (const slot of SCATTER_SLOTS) {
      const left = slot.x - slot.w / 2;
      const right = slot.x + slot.w / 2;
      // Authored for the LEFT column: it may spill left (outward), never right.
      expect(right).toBeLessThanOrEqual(103);
      // Mirrored for the right column, that spill becomes a right-hand one.
      const mirrored = mirrorScatter(slot);
      expect(mirrored.x - mirrored.w / 2).toBeGreaterThanOrEqual(-3);
      // And an overhang worth having is still a frame you can read.
      if (left < 0) expect(left).toBeGreaterThan(-20);
    }
  });

  it("keeps every frame's centre inside the column", () => {
    for (const slot of [...SCATTER_SLOTS, ...CLUSTER_SLOTS]) {
      expect(slot.x).toBeGreaterThan(0);
      expect(slot.x).toBeLessThan(100);
    }
  });
});

describe("cluster placement", () => {
  it("shows the centre figure first, so one cutout is still a composition", () => {
    const placed = placeCluster(["only.png"], false);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.slot.x).toBe(50);
  });

  it("stands every figure on the same rough baseline", () => {
    const baselines = CLUSTER_SLOTS.map((slot) => slot.bottom);
    expect(Math.max(...baselines) - Math.min(...baselines)).toBeLessThanOrEqual(6);
  });

  /** The heavy word lives under the cluster; every figure has to clear it. */
  it("leaves the bottom of the column free for the word", () => {
    for (const slot of CLUSTER_SLOTS) expect(slot.bottom).toBeGreaterThanOrEqual(14);
  });

  it("keeps every figure inside the column's height", () => {
    for (const slot of CLUSTER_SLOTS) expect(slot.bottom + slot.h).toBeLessThanOrEqual(95);
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

describe("variant selection", () => {
  it("accepts only the two designs that exist", () => {
    expect(parseVariant("1")).toBe(1);
    expect(parseVariant("2")).toBe(2);
    expect(parseVariant("3")).toBeNull();
    expect(parseVariant(null)).toBeNull();
  });

  it("falls back to the live variant when ?v= is absent or junk", () => {
    expect(preferenceVariant("?v=nonsense")).toBe(1);
    expect(preferenceVariant("")).toBe(1);
  });

  it("flips the query param without losing the rest of the URL", () => {
    expect(
      otherVariantHref(1, "http://localhost:5173/onboarding.html?preview=basics:preference"),
    ).toBe("http://localhost:5173/onboarding.html?preview=basics%3Apreference&v=2");
    expect(otherVariantHref(2, "http://localhost:5173/onboarding.html?v=2")).toBe(
      "http://localhost:5173/onboarding.html?v=1",
    );
  });
});
