import { describe, expect, it } from "vitest";
import { PREF_REVEAL_CAP_MS, revealTally } from "./preference-reveal.js";
import { placeScatter } from "./preference-layout.js";
import { photoSet } from "./preference-photos.js";

const MEN = ["m1", "m2", "m3"];
const WOMEN = ["w1", "w2", "w3"];

describe("preference reveal tally", () => {
  /**
   * The rule the whole module exists for. Anything that reveals earlier —
   * per photo, or per column — puts a half-built composition on screen, which
   * is the bug, not a smaller version of it.
   */
  it("reveals only once every photograph on the screen is in", () => {
    const tally = revealTally([...MEN, ...WOMEN]);
    const settled = [...MEN, ...WOMEN].map((src) => tally.settle(src));

    expect(settled.slice(0, -1)).toEqual([false, false, false, false, false]);
    expect(settled.at(-1)).toBe(true);
  });

  /** A whole column arriving first is exactly the case that must NOT reveal. */
  it("does not reveal on one column alone", () => {
    const tally = revealTally([...MEN, ...WOMEN]);
    for (const src of MEN) expect(tally.settle(src)).toBe(false);
    expect(tally.outstanding).toBe(WOMEN.length);
  });

  /**
   * A ref callback can fire more than once for the same element. A repeat that
   * counted twice would stand in for a photograph still on the wire.
   */
  it("counts a repeat as nothing", () => {
    const tally = revealTally(MEN);
    expect(tally.settle("m1")).toBe(false);
    expect(tally.settle("m1")).toBe(false);
    expect(tally.settle("m1")).toBe(false);
    expect(tally.outstanding).toBe(2);
  });

  it("ignores a photograph it was never given", () => {
    const tally = revealTally(MEN);
    expect(tally.settle("nope")).toBe(false);
    expect(tally.outstanding).toBe(MEN.length);
  });

  /**
   * Seeds the component's `revealed` state, so a screen with no photographs at
   * all shows immediately instead of waiting out the cap on nothing.
   */
  it("starts settled when there is nothing to wait for", () => {
    expect(revealTally([]).outstanding).toBe(0);
  });

  /**
   * The cap is the last resort for a request that neither answers nor errors.
   * Long enough that a merely slow connection still gets the all-at-once
   * reveal, short enough that a stuck one does not leave the columns bare.
   */
  it("keeps the cap inside the window a user will wait", () => {
    expect(PREF_REVEAL_CAP_MS).toBeGreaterThan(1000);
    expect(PREF_REVEAL_CAP_MS).toBeLessThanOrEqual(3000);
  });
});

describe("what the screen actually counts", () => {
  /**
   * The tally must be fed the RENDERED photographs, not the folder: the scatter
   * truncates to its slot count, so a seventh photo dropped into either folder
   * would have no element to decode and would hold the screen back until the
   * cap on every single visit. This pins that the two agree today, and fails
   * loudly the moment a folder outgrows the composition.
   */
  it("renders every photograph the folders ship", () => {
    for (const side of ["men", "women"] as const) {
      const photos = photoSet(side);
      expect(photos.length).toBeGreaterThan(0);
      expect(placeScatter(photos, side === "women")).toHaveLength(photos.length);
    }
  });
});
