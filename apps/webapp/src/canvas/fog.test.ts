import { describe, expect, it } from "vitest";

import { fogPath, formatExplored, tileBounds } from "./fog.js";

/** A viewport whose projection is trivial to reason about: 1° = 10 px. */
function viewport(width = 400, height = 800) {
  return {
    width,
    height,
    project(lat: number, lng: number) {
      // Latitude grows northward, pixels grow downward — the sign flip here is
      // the thing the fog gets wrong if nobody is watching.
      return { x: (lng - 30) * 10, y: (51 - lat) * 10 };
    },
  };
}

describe("tileBounds", () => {
  // Pinned to the SAME published vector as `@gennety/shared/geohash`. This is
  // the only thing standing between two hand-maintained copies of one decode
  // and a silent drift between them.
  it("agrees with the shared decode on the reference vector", () => {
    const bounds = tileBounds("u4pruy")!;
    expect(bounds.minLat).toBeCloseTo(57.645263671875, 9);
    expect(bounds.maxLat).toBeCloseTo(57.6507568359375, 9);
    expect(bounds.minLng).toBeCloseTo(10.404052734375, 9);
    expect(bounds.maxLng).toBeCloseTo(10.4150390625, 9);
  });

  it("refuses anything that is not one of our tiles", () => {
    expect(tileBounds("u4pru")).toBeNull();
    expect(tileBounds("u4pruy1")).toBeNull();
    expect(tileBounds("u4prua")).toBeNull();
  });
});

describe("fogPath", () => {
  // A fully-fogged map with no data hides everything, says nothing, and looks
  // exactly like a bug. Better to draw no fog at all.
  it("draws nothing at all when nothing is known", () => {
    expect(fogPath([], viewport())).toBeNull();
  });

  it("draws nothing when every tile is unparseable", () => {
    expect(fogPath(["nope", "alsonope"], viewport())).toBeNull();
  });

  it("covers the whole viewport and punches one hole per tile", () => {
    const path = fogPath(["u8vmxh", "u8vmxj"], viewport())!;

    // Outer ring first — the veil itself.
    expect(path.startsWith("M0 0H400V800H0Z")).toBe(true);
    // Two inner rings. Even-odd fill turns them into holes; separate elements
    // would seam where two uncovered tiles touch, which is the common case.
    expect(path.match(/M[^M]*Z/g)).toHaveLength(3);
  });

  // Drawing a valid rectangle in the wrong place is the kind of wrong that
  // looks plausible on screen, so the corner is asserted rather than eyeballed.
  it("anchors a hole at the tile's north-west corner", () => {
    const tile = "u8vmxh";
    const bounds = tileBounds(tile)!;
    const view = viewport();
    const path = fogPath([tile], view)!;

    const expected = view.project(bounds.maxLat, bounds.minLng);
    const hole = path.slice(path.indexOf("Z") + 1);
    expect(hole.startsWith(`M${expected.x} ${expected.y}`)).toBe(true);
  });

  // At city zoom most of a heavy user's tiles are off-screen, and each one
  // still costs a path segment.
  it("skips tiles that are not in view", () => {
    const inView = fogPath(["u8vmxh"], viewport())!;
    const withStray = fogPath(["u8vmxh", "u4pruy"], viewport())!;
    expect(withStray).toBe(inView);
  });
});

describe("formatExplored", () => {
  it("says nothing rather than zero when nothing is uncovered", () => {
    expect(formatExplored(0)).toBe("0%");
  });

  // One tile of Kyiv is 0.034%. Rendering "0.0%" to someone who has just
  // walked their first square tells them the feature is broken.
  it("never rounds a real first tile down to nothing", () => {
    expect(formatExplored(0.00034)).toBe("0.1%");
  });

  it("reads as a percentage of the city", () => {
    expect(formatExplored(0.125)).toBe("12.5%");
    expect(formatExplored(1)).toBe("100%");
  });
});
