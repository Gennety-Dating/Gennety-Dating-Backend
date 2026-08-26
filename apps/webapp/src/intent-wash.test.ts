import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest runs it happily.
// Non-empty only because vite.config.ts lists these in `test.css.include`.
import CSS from "./onboarding.css?raw";
import TSX from "./onboarding-basics.tsx?raw";
import { tileClass } from "./intent-wash.js";

/**
 * The tap-to-spread wash on the relationship-intent tiles.
 *
 * It shipped broken twice, in two different ways, and neither failure showed up
 * as an error — the screen simply looked like the selection arrived instantly,
 * which is indistinguishable from "no animation was written". Both are guarded
 * here because both are one careless edit away from returning:
 *
 *  1. The class that runs the animation was added imperatively in the click
 *     handler. The same tap also calls `setPicked`, React re-renders, and its
 *     own `className` overwrites anything written by hand — so the class was
 *     wiped in the tick it was added. Measured: the tile read `ob-intent is-on`
 *     40ms after the tap, and `document.getAnimations()` held no `intent-spread`
 *     at all.
 *  2. The settled state was a flat fill on `.is-on`, which lands at tap time.
 *     It covered the tile before the first blob had moved, so even with the
 *     class applied there would have been nothing to see. The resting wash is
 *     the union of the three blobs instead.
 */

/** Every top-level rule in the stylesheet, as an authored selector list plus body. */
const RULES: Array<{ selectors: string[]; body: string }> = [
  ...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => ({
  selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean),
  body: m[2],
}));

/**
 * The declarations of the rule whose selector list is EXACTLY these selectors.
 * Matching on a substring is what made the first pass of this file pass for the
 * wrong reason: `.ob-intent.is-on .ob-intent-label` is a prefix of
 * `.ob-intent.is-on .ob-intent-label::before`, which is declared earlier.
 */
function declarations(...selectors: string[]): string {
  const hit = RULES.find(
    (r) =>
      r.selectors.length === selectors.length &&
      selectors.every((s, i) => r.selectors[i] === s),
  );
  expect(hit, `no rule for ${selectors.join(", ")}`).toBeDefined();
  return hit?.body ?? "";
}

/** The rule that parks the blobs at full scale, whatever its selector list is. */
function parkedBlobRule(): { selectors: string[]; body: string } {
  const hit = RULES.find(
    (r) => /scale:\s*1\b/.test(r.body) && r.selectors.some((s) => s.includes("::before")),
  );
  expect(hit, "no rule parks the wash blobs at full scale").toBeDefined();
  return hit as { selectors: string[]; body: string };
}

describe("intent wash — which classes a tile carries", () => {
  it("gives an untouched tile neither wash class", () => {
    // Otherwise the first paint plays four recede animations at once, on a
    // screen where nothing has been deselected because nothing was ever chosen.
    expect(tileClass(false, undefined)).toBe("ob-intent");
  });

  it("spreads on selection and recedes on deselection", () => {
    expect(tileClass(true, "on")).toBe("ob-intent is-on is-spreading");
    expect(tileClass(false, "off")).toBe("ob-intent is-receding");
  });

  it("keeps the settled tile selected once its wash class is gone", () => {
    // A tile restored from the server was never tapped, so it has no wave.
    expect(tileClass(true, undefined)).toBe("ob-intent is-on");
  });
});

describe("intent wash — the class cannot be written imperatively", () => {
  it("never adds the wash classes through the DOM", () => {
    // React owns `className` here and rewrites it on the same tap, so a
    // `classList.add` is silently undone. The anchor point stays imperative
    // (nothing passes a `style` prop), which is why only this half is guarded.
    const body = TSX.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(body).not.toMatch(/classList\.(add|remove|toggle)/);
    expect(body).toContain("tileClass(");
  });
});

describe("intent wash — the spread is not painted over", () => {
  it("gives the settled wash no fill of its own", () => {
    // `is-on` lands at tap time. A `background` here is on screen before the
    // first blob has moved, which is exactly how the spread went unseen.
    expect(declarations(".ob-intent.is-on .ob-intent-wash")).not.toMatch(/background/);
  });

  it("parks the blobs while receding, not only while selected", () => {
    // The animation that held them at full scale belongs to `is-spreading` and
    // goes with it, so without this the wash vanishes in one frame instead of
    // fading.
    const parked = parkedBlobRule();
    for (const state of ["is-on", "is-receding"]) {
      for (const blob of [
        ".ob-intent-wash::before",
        ".ob-intent-wash::after",
        ".ob-intent-label::before",
      ]) {
        expect(parked.selectors).toContain(`.ob-intent.${state} ${blob}`);
      }
    }
  });

  it("grows each blob far enough to cover the tile from a corner", () => {
    // The opaque core — not the soft edge — has to reach the far corner, or a
    // corner tap leaves the opposite one bare and the resting wash needs the
    // flat fill this whole change removed. In a 3:4 tile the diagonal is 1.66x
    // the width and the core ends at 70% of the blob's radius: 1.66 / 0.7 x 2.
    const width = /width:\s*(\d+)%/.exec(
      declarations(
        ".ob-intent-wash::before",
        ".ob-intent-wash::after",
        ".ob-intent-label::before",
      ),
    );
    expect(width, "blob width is not declared as a percentage").not.toBeNull();
    expect(Number(width?.[1])).toBeGreaterThanOrEqual(475);
  });

  it("keeps the three blobs faint enough that their union is the resting wash", () => {
    // Each used to be near-final on its own, so the first one covered the tile
    // and the other two had nothing left to show. Their union has to land near
    // the 0.66 the flat fill used to paint: 1 - 0.69 x 0.70 x 0.71.
    const alphas = [
      ...CSS.matchAll(/rgba\(255, 255, 255, (0\.\d+)\) 0 6\d%|rgba\(255, 255, 255, (0\.\d+)\) 0 70%/g),
    ].map((m) => Number(m[1] ?? m[2]));
    expect(alphas.length, "expected three blob core alphas").toBe(3);
    for (const alpha of alphas) expect(alpha).toBeLessThan(0.4);
    const union = 1 - alphas.reduce((acc, a) => acc * (1 - a), 1);
    expect(union).toBeGreaterThan(0.6);
    expect(union).toBeLessThan(0.72);
  });
});

describe("intent wash — the label waits for the ground to change", () => {
  it("delays the ink flip until the wash is under the text", () => {
    // Burgundy on a photograph is the one state this label may never be in,
    // and that is what an undelayed flip shows for most of a second.
    const flip = declarations(".ob-intent.is-on .ob-intent-label");
    const delay = /transition:\s*color\s+\d+ms\s+\w+\s+(\d+)ms/.exec(flip);
    expect(delay, "the selected label sets no transition delay").not.toBeNull();
    expect(Number(delay?.[1])).toBeGreaterThanOrEqual(400);
  });

  it("does not make deselection wait for that delay", () => {
    // The ground goes back to a photograph immediately, so the ink has to.
    const back = declarations(".ob-intent.is-receding .ob-intent-label");
    expect(back).toMatch(/transition:\s*color\s+\d+ms\s+\w+\s*,/);
    expect(back).not.toMatch(/color\s+\d+ms\s+\w+\s+\d+ms/);
  });
});
