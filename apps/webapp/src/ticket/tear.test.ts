import { describe, expect, it } from "vitest";

import { TEAR_AMPLITUDE, TEAR_JITTER, TEAR_TEETH, tearEdge, tearPolygons } from "./tear.js";

describe("tearEdge", () => {
  it("spans the whole card, edge to edge", () => {
    const edge = tearEdge(268, 332);
    expect(edge).toHaveLength(TEAR_TEETH + 1);
    expect(edge[0]![0]).toBe(0);
    expect(edge.at(-1)![0]).toBe(268);
  });

  it("stays within a tooth of the perforation — a tear, not a slash", () => {
    for (const [, y] of tearEdge(268, 332)) {
      expect(Math.abs(y - 332)).toBeLessThanOrEqual(TEAR_AMPLITUDE + TEAR_JITTER + 0.1);
    }
  });

  it("is the same edge every time", () => {
    expect(tearEdge(268, 332)).toEqual(tearEdge(268, 332));
  });
});

describe("tearPolygons", () => {
  it("cuts both pieces along ONE line, so they fit back together", () => {
    const { top, stub } = tearPolygons(268, 332);
    const points = (polygon: string): string[] =>
      polygon.replace(/^polygon\(|\)$/g, "").split(", ");
    const edge = tearEdge(268, 332).map(([x, y]) => `${x}px ${y}px`);
    // The top piece walks the edge right-to-left after its two top corners…
    expect(points(top).slice(2)).toEqual([...edge].reverse());
    // …and the stub walks it left-to-right before its two bottom corners.
    expect(points(stub).slice(0, edge.length)).toEqual(edge);
    expect(points(stub).slice(-2)).toEqual(["268px 100%", "0px 100%"]);
  });
});
