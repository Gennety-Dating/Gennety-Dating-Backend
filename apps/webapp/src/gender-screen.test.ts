import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest runs it happily.
import CSS from "./onboarding.css?raw";
import { GENDER_ART_CHIN_PCT } from "./gender-avatars.js";
import {
  GENDER_ADVANCE_HOLD_CEILING_MS,
  GENDER_ADVANCE_HOLD_MS,
  GENDER_REVEAL_MS,
} from "./onboarding-timing.js";

/**
 * The gender screen shows two drawn portraits that are monochrome at rest and
 * bloom into colour on the tap that commits the answer.
 *
 * Four things are worth holding, and each of them is something that looks like
 * tidying up until it breaks.
 */
function block(selector: string): string {
  const at = CSS.indexOf(selector);
  expect(at, `${selector} missing from onboarding.css`).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf("}", at));
}

describe("gender screen", () => {
  /**
   * The CSS duration and the TS constant describe the same animation, and only
   * one of them is visible from the code that decides how long to hold the
   * screen. They must not drift.
   */
  it("keeps the CSS bloom duration equal to GENDER_REVEAL_MS", () => {
    const declared = /--gender-reveal:\s*(\d+)ms/.exec(CSS);
    expect(declared, "--gender-reveal missing from onboarding.css").not.toBeNull();
    expect(Number(declared?.[1])).toBe(GENDER_REVEAL_MS);
  });

  /**
   * The hold has to outlast the bloom, or the screen advances mid-reaction and
   * the whole mechanic is invisible — but it is also real time added to the
   * onboarding funnel for every user, so it gets a stated ceiling rather than
   * being allowed to creep one retune at a time. Same treatment as the success
   * mark's timings.
   */
  it("holds the screen long enough to see the bloom, and no longer than the ceiling", () => {
    expect(GENDER_ADVANCE_HOLD_MS).toBeGreaterThanOrEqual(GENDER_REVEAL_MS);
    expect(GENDER_ADVANCE_HOLD_MS).toBeLessThanOrEqual(GENDER_ADVANCE_HOLD_CEILING_MS);
  });

  /**
   * An element with an animated `filter` gets its own compositor layer in
   * Chromium and floats above a positioned sibling. Without an explicit stacking
   * order the portrait rides over its own label the moment the colour starts
   * blooming — the same trap the metrics screen's icons hit.
   */
  it("gives the portrait layer an explicit stacking order", () => {
    expect(block(".ob-gender-art {")).toMatch(/z-index:\s*1/);
    expect(block(".ob-gender-label {")).toMatch(/z-index:\s*2/);
  });

  /**
   * The bottom of the photograph dissolves into the button's gradient — the
   * handover from person to colour, and what leaves the label on clean colour
   * instead of needing a scrim over it.
   */
  it("dissolves the artwork into the button on three sides", () => {
    const art = block(".ob-gender-art {");
    expect(art).toMatch(/--fade-v:\s*linear-gradient\(\s*180deg/);
    expect(art).toMatch(/-webkit-mask-image:\s*var\(--fade-v\)/);
    // The sides matter as much as the bottom: without them the shoulders run
    // into the button's edge and stop, which is what reads as a pasted cut-out.
    const shot = block(".ob-gender-shot {");
    expect(shot).toMatch(/--fade-h:\s*linear-gradient\(\s*90deg/);
    expect(shot).toMatch(/-webkit-mask-image:\s*var\(--fade-h\)/);
  });

  /**
   * And it must begin BELOW the chin. The figure is placed in the asset by
   * measured landmarks, so where the face ends is a known number rather than
   * something the fade has to be safe about — but the two live in different
   * files (the prep script is outside the repo), so nothing else stops the fade
   * from being moved back up and quietly dissolving a face.
   */
  it("starts the fade below the face", () => {
    const stop = /--fade-v:\s*linear-gradient\(\s*180deg,\s*#000\s+(\d+)%/.exec(
      block(".ob-gender-art {"),
    );
    expect(stop, "could not read the mask's first stop").not.toBeNull();
    expect(Number(stop?.[1])).toBeGreaterThanOrEqual(GENDER_ART_CHIN_PCT);
  });

  /**
   * The neutral rest state exists only as the setup for the reveal, so with the
   * reveal gone it must not survive as a desaturated picture for no reason.
   */
  it("drops the monochrome rest state under reduced motion", () => {
    const at = CSS.indexOf("@media (prefers-reduced-motion: reduce)", CSS.indexOf(".ob-gender-shot"));
    expect(at).toBeGreaterThan(-1);
    const scope = CSS.slice(at, at + 400);
    expect(scope).toContain(".ob-gender-shot");
    expect(scope).toMatch(/filter:\s*none/);
  });
});
