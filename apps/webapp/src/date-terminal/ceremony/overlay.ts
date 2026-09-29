/**
 * Painting one frame of the ceremony over the terminal — the stand's `screen`
 * without its stand-ins: the terminal is the real screen under the scene and
 * the phone brings its own island, so what is left is the stand's order:
 *
 *   wash (the terminal dims) → capsule → plaque → mascot.
 *
 * The terminal's own blur is not painted: a canvas cannot read the DOM under
 * it, so the overlay puts a `backdrop-filter` of `backdropBlurPx(f.blur)` under
 * this canvas instead.
 */

import type { CeremonyFrame, CeremonyPlan } from "./ceremony-stand.js";
import { Render } from "./render-stand.js";

/** The terminal is dark glass in both themes (date-terminal.html). */
export const CEREMONY_DARK = true;

/** How long the final plaque stays after the scene ends, before the overlay fades. */
export const CEREMONY_LINGER_MS = 1_200;
/** The overlay's fade-out. */
export const CEREMONY_FADE_MS = 420;

/**
 * The stand defocuses its screen by cross-fading the sharp layer into a copy
 * shrunk ×6 in DEVICE pixels (`blurred`); at the scene's steady
 * `f.blur = 0.45` that reads as a Gaussian of about one point. CSS `blur()`
 * takes that deviation in CSS px (= points), so ≈ 2.4 px per unit of `f.blur`.
 * (A first pass at 6 px per unit, checked headless, blurred the terminal well
 * past the stand's look.)
 */
export function backdropBlurPx(blur: number): number {
  return Math.max(0, 2.4 * blur);
}

export function paintCeremony(ctx: CanvasRenderingContext2D, f: CeremonyFrame, w: number, h: number): void {
  const pal = Render.palette(CEREMONY_DARK);
  if (f.stage > 0) {
    ctx.fillStyle = `${pal.wash}${(CEREMONY_DARK ? 0.42 : 0.5) * f.stage})`;
    ctx.fillRect(0, 0, w, h);
  }
  Render.capsule(ctx, f.capsule, pal, f.t);
  Render.plaque(ctx, f.plaque, pal);
  if (f.mascot) Render.mascot(ctx, f.mascot);
}

/**
 * The hold is in and the server has not answered: the stand's waiting capsule
 * (role A at t < 0), drawn before anyone knows the role. `clockMs` only runs
 * the sheen — the one infinite motion the screen allows (a loading state).
 */
export function paintWaiting(ctx: CanvasRenderingContext2D, plan: CeremonyPlan, label: string, clockMs: number): void {
  const L = plan.A.L;
  const d = plan.A.d;
  Render.capsule(
    ctx,
    { x: d.w / 2, y: L.capY, w: L.capW, h: L.capH, fill: 1, label, labelAlpha: 1, waiting: true },
    Render.palette(CEREMONY_DARK),
    clockMs,
  );
}
