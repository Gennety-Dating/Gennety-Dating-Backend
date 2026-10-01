import { describe, expect, it } from "vitest";
import CSS from "./onboarding.css?raw";
import SCREEN from "./onboarding-basics.tsx?raw";
import { INTENT_CYCLE_MS, INTENT_FRAMES, rotateToRest } from "./intent-cycle.js";

/**
 * The relationship-intent tile: which photograph plays when, and the four
 * things about the selected state that are load-bearing rather than styling
 * (PRODUCT_SPEC §1.3).
 *
 * Every one of these guards a defect that was actually shipped into the
 * preview and had to be found by rendering the page — none of them fails a
 * typecheck, a lint or a reading of the diff.
 */

/** Exact-selector-list lookup: substring matching would let `.ob-intent-photo`
 *  answer for `.ob-intent-photo::before` and pass for the wrong reason. */
const RULES: Array<{ selectors: string[]; body: string }> = [
  ...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((match) => ({
  selectors: match[1].split(",").map((s) => s.trim()).filter(Boolean),
  body: match[2],
}));

function declarations(...selectors: string[]): string {
  const rule = RULES.find(
    (r) => r.selectors.length === selectors.length && selectors.every((s) => r.selectors.includes(s)),
  );
  if (!rule) throw new Error(`no rule for ${selectors.join(", ")}`);
  return rule.body;
}

function zIndexOf(selector: string): number {
  const found = /z-index:\s*(-?\d+)/.exec(declarations(selector));
  if (!found) throw new Error(`${selector} declares no z-index`);
  return Number(found[1]);
}

describe("the founder's cycle order", () => {
  it("plays his sequence, rotated to start on the frame already showing", () => {
    // `open` is the only option whose resting frame is not first in his list,
    // so it is the only one this actually moves — and the same loop is kept:
    // 3 2 5 4 started at 5 is 5 4 3 2.
    expect(rotateToRest([3, 2, 5, 4], 5)).toEqual([5, 4, 3, 2]);
    expect(rotateToRest([2, 3, 4, 5], 2)).toEqual([2, 3, 4, 5]);
  });

  it("refuses an order that does not contain the resting frame", () => {
    expect(() => rotateToRest([1, 2, 3], 9)).toThrow(/not in the cycle/);
  });

  it("names a resting frame that is actually in its own cycle", () => {
    // A typo here throws at module load in production, where the screen is the
    // last step of registration.
    for (const [id, frames] of Object.entries(INTENT_FRAMES)) {
      expect(frames.order, id).toContain(frames.rest);
    }
  });

  it("gives every option at least three frames", () => {
    // The crossfade keeps exactly two layers opaque (live + the one under it).
    // With two frames the incoming one is the outgoing one, which is already
    // opaque, so the swap reads as a cut instead of a fade.
    for (const [id, frames] of Object.entries(INTENT_FRAMES)) {
      expect(frames.order.length, id).toBeGreaterThanOrEqual(3);
    }
  });

  it("holds each photograph for two seconds", () => {
    expect(INTENT_CYCLE_MS).toBe(2000);
  });
});

describe("the selected tile", () => {
  it("keeps the label and the check above every photograph", () => {
    // The photographs stack to 3 while they cross-fade. The label sat at 2, so
    // a tile went wordless the moment it advanced past its first frame — and
    // only past it, which is why nothing caught it until the page ran.
    expect(zIndexOf(".ob-intent-label")).toBeGreaterThan(3);
    expect(zIndexOf(".ob-intent-check")).toBeGreaterThan(3);
  });

  it("sizes the photograph rather than insetting it", () => {
    // For an absolutely-positioned REPLACED element `width: auto` resolves to
    // the intrinsic width (540px) and the `right` offset is dropped as
    // over-constrained, so `inset` alone hangs the picture 381px off the tile.
    const photo = declarations(".ob-intent-photo");
    expect(photo).toMatch(/width:\s*100%/);
    expect(photo).toMatch(/height:\s*100%/);
    expect(photo).not.toMatch(/(^|;)\s*inset:/);
  });

  it("reveals the ring with a clip, by the ring's own width on every side", () => {
    // The frame is the gap between the clip and the tile's edge, so it is only
    // a frame if it is even — which `inset()` is and a scaled 3:4 box is not.
    expect(declarations(".ob-intent.is-on .ob-intent-frames")).toMatch(
      /clip-path:\s*inset\(var\(--intent-ring\) round calc\(20px - var\(--intent-ring\)\)\)/,
    );
  });

  it("animates the selection on the compositor and the clip only", () => {
    // Selecting a tile used to transition top/left/width/height/border-radius of
    // the photographs, the label's margin, the tile's box-shadow and a filter —
    // twenty transitions per tap, most of them relayout or repaint every frame.
    const intentRules = RULES.filter((rule) =>
      rule.selectors.some((selector) => selector.includes(".ob-intent")),
    );
    const transitioned = intentRules.flatMap((rule) =>
      [...rule.body.matchAll(/transition:\s*([^;]+);/g)].flatMap(([, value]) =>
        value
          // Commas inside cubic-bezier(...) are not list separators.
          .split(/,(?![^(]*\))/)
          .map((part) => part.trim().split(/\s+/)[0])
          .filter((property) => property !== "none"),
      ),
    );
    expect(transitioned.length).toBeGreaterThan(0);
    for (const property of transitioned) {
      expect(["opacity", "transform", "translate", "scale", "clip-path"]).toContain(property);
    }
  });

  it("lights the ring from its borders inward, not from the middle out", () => {
    // The house recipe: a NEGATIVE spread pulls each shadow's body out past its
    // own edge and leaves only the falloff pointing in. At zero or positive the
    // same declaration is a vignette pressing inward — the opposite reading.
    // It lives on a pre-rendered layer that only fades (`.ob-intent::before`).
    const inset = [...declarations(".ob-intent::before").matchAll(/inset (-?\d+px) 0 (\d+px) (-?\d+px)|inset 0 (-?\d+px) (\d+px) (-?\d+px)/g)];
    expect(inset.length).toBeGreaterThanOrEqual(4);
    for (const shadow of inset) {
      const spread = shadow[3] ?? shadow[6];
      expect(Number.parseInt(spread, 10)).toBeLessThan(0);
    }
  });

  it("lays the tile out as a column so the label spans it", () => {
    // As a row item the label was content-width: a short one ("Влюбиться") sat
    // against the left edge, and a wrapping one only looked centred because it
    // had run out of room.
    expect(declarations(".ob-intent")).toMatch(/flex-direction:\s*column/);
  });

  it("mounts every frame up front, so the tap only changes opacity", () => {
    // Reversed 2026-10-01. Mounting the other three on selection saved their
    // bytes for options nobody picked, but it put three fresh WebP decodes on
    // the exact frame the selection animates. The cost now lands at rest.
    expect(SCREEN).toMatch(/\{photos\.map\(\(src, index\) =>/);
    expect(SCREEN).not.toMatch(/photos\.slice\(0, 1\)/);
    expect(SCREEN).toMatch(/decoding="async"/);
  });

  it("stops the cycle and every transition under reduced motion", () => {
    // Anchored at the intent block rather than at the last one in the file:
    // other screens carry their own reduced-motion rules.
    const at = CSS.indexOf("@media (prefers-reduced-motion: reduce)", CSS.indexOf(".ob-intent-check"));
    const block = CSS.slice(at, CSS.indexOf("}\n}", at) + 3);
    expect(block).toMatch(/\.ob-intent-photo/);
    expect(block).toMatch(/transition:\s*none/);
    expect(SCREEN).toMatch(/if \(prefersReducedMotion\(\) \|\| photos\.length < 2\) return;/);
  });
});
