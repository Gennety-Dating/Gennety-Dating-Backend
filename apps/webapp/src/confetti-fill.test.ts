import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest runs it happily.
import SRC from "./main.ts?raw";

/**
 * The agreed screen's confetti is staggered — each piece gets its own delay of
 * up to 1.5s — and a delayed animation renders the element's OWN style until
 * its turn comes. With the default `fill: none` that style carries no
 * transform, so every waiting piece sits at y=0, fully opaque, pinned flush to
 * the top edge of the screen. Measured on the real render at 390x844: 40/40
 * parked at the top edge at t=0, 33 still parked at 400ms, 21 at 800ms. That
 * is the founder's "они как будто сверху экрана застревают".
 *
 * The fix is `backwards`, which spends the delay holding the 0% keyframe
 * (translateY(-10vh)) instead — above the screen, invisible, until the piece
 * genuinely starts to fall.
 *
 * What this test actually protects is WHERE it is declared. The animation is
 * assigned as an inline shorthand, and a shorthand resets fill-mode to `none`,
 * so the same fix written as an `animation-fill-mode` rule in the stylesheet
 * is silently dead — verified: the CSS-only version changed not a single
 * measured pixel. Moving it there later would look like a tidy-up and would
 * restore the bug with nothing failing.
 */
describe("confetti fall", () => {
  /** The `fall` animation shorthand exactly as `runConfetti` assigns it. */
  function shorthand(): string {
    const m = /piece\.style\.animation\s*=\s*`([^`]*)`/.exec(SRC);
    if (!m) throw new Error("runConfetti no longer assigns an animation shorthand");
    return m[1]!;
  }

  it("holds the first keyframe through the stagger delay", () => {
    expect(shorthand()).toMatch(/\bbackwards\b|\bboth\b/);
  });

  it("still staggers the pieces (the delay is what makes the fill matter)", () => {
    expect(shorthand()).toMatch(/\$\{delay\}s/);
  });
});
