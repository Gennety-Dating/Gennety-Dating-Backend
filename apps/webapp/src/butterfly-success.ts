/**
 * The shared success mark for every Mini App: the brand butterfly spins away and
 * leaves a checkmark.
 *
 * The beat is one gesture in four parts — the logo sits still, winds back to the
 * right, then spins left with ACCELERATION, shrinking as it goes until it is a
 * point; the checkmark draws itself in the space it vacated. The resting frame
 * is a plain bold tick and nothing else.
 *
 * ## Why there is a tick again
 *
 * This is the fourth version, and the previous three all argued about the same
 * thing: whether the frame people look at longest should carry the logo or the
 * outcome. Two of them put a butterfly ON a tick (a logo perched on a point
 * reads as a sticker) and one removed the tick entirely, on the finding that a
 * butterfly flying ALONG the tick's path rendered **29 x 29 px** — the logo is
 * an abstract four-lobe shape with no body, head or antennae, so at that size it
 * was a pink smudge, and "the brand moment is the MOTION" failed on its own
 * terms because the moving object was never recognisable.
 *
 * That finding is intact and this mark does not re-break it: the butterfly is
 * never small while it is meant to be READ. It holds still at full size, and
 * shrinking is what makes it leave, not what it does while performing. The
 * branded moment is the first half of the animation, at 143px.
 *
 * **What is knowingly given up:** the resting frame is a generic checkmark
 * carrying no brand. That is the cost of "minimal and classic", it was named
 * before this was built, and it is the founder's call (DECISIONS.md).
 *
 * ## The consequence to hold onto
 *
 * The mark now says "done" on its own again, so — unlike the butterfly-only
 * version — a sixth call site with neither `label` nor a heading of its own is
 * merely quiet, not meaningless. The accessible name still matters: the drawing
 * is `aria-hidden`, so a mark with no `label` needs `ariaLabel` or the success
 * is announced to nobody.
 *
 * `brand-butterfly.ts` owns the silhouette and the gradient;
 * `butterfly-success.css` owns motion, size and colour. The loading mark
 * (`butterfly-loader.ts`, three butterflies inside a waist) is deliberately a
 * different picture: nerves, against this one's resolution.
 */

import "./butterfly-success.css";
import { WING_LEFT, WING_RIGHT, escapeHtml, logoWingGradient } from "./brand-butterfly.js";

/**
 * How long until the tick is fully drawn, in ms.
 *
 * This is the moment the mark MEANS something, and what call sites treat as
 * "it landed" — the haptic fires here. Everything after it is the bloom and the
 * caption catching up, which nobody is waiting on.
 *
 * It is 1180ms against the butterfly-only mark's 520ms, because there is now an
 * actual gesture rather than a single pop. It is close to the 1200ms the earlier
 * drawn-tick version ran at, so the two self-dismissing screens are back to
 * roughly the timing they were built around.
 */
export const SUCCESS_ARRIVE_MS = 1180;

/**
 * Everything still moving after the tick has landed: the bloom behind it and the
 * caption below.
 *
 * A test pins this against the stylesheet, because both are declared there as
 * delay-plus-duration pairs and the failure mode is a self-dismissing screen
 * closing over a glow that is still rising.
 */
export const SUCCESS_SETTLE_MS = 120;

/**
 * The whole beat, start to rest.
 *
 * Load-bearing for the two screens that DISMISS themselves: verification closes
 * the WebView on a timer and Type Radar closes after its save, and a close fired
 * mid-animation shows the user a half-drawn tick. Those call sites derive their
 * delay from this rather than carrying a hand-tuned constant that silently stops
 * matching the animation.
 */
export const SUCCESS_TOTAL_MS = SUCCESS_ARRIVE_MS + SUCCESS_SETTLE_MS;

/**
 * How long a mark that has come to rest is held before a self-dismissing screen
 * closes over it.
 *
 * Deliberately unchanged across every version of this mark: `SUCCESS_TOTAL_MS`
 * answers "when does it stop moving", this answers "how long does a person need
 * to see that it did", and the second question is not affected by the first.
 */
export const SUCCESS_READ_MS = 1100;

/**
 * The largest the butterfly ever gets, at the top of the wind-up.
 *
 * Small on purpose: the grow is an inhale before the spin, not an event. The
 * viewBox is NOT sized from this alone — a rotating rectangle is widest at 45°,
 * where its half-extent is `(w + h) / 2√2 = 53.8`, far past the 44.3 it occupies
 * upright. The test walks the real keyframes, interpolated, against the frame.
 */
export const SPIN_PEAK_SCALE = 1.05;

/**
 * The drawing surface — SQUARE, which is the whole reason it changed.
 *
 * The butterfly spins, so it needs the same clearance vertically as
 * horizontally: at 45° it reaches 53.8 units from the centre in both axes
 * (times the scale it happens to be at, ~1.02 there → 54.9). 118 x 118 gives
 * half-extents of 59, so ~4 units of margin. The old 104 x 76 frame was sized
 * for a butterfly that never turned and would have sheared a wing off on the
 * first quarter-turn.
 */
export const VIEWBOX = { width: 118, height: 118 } as const;

/**
 * The checkmark, in the same origin-centred user space as the wings.
 *
 * Three points, arms at roughly 1:1.9 — the classic proportion; a tick with
 * even arms reads as a chevron. Written out rather than generated because it is
 * the one shape on the screen at rest and every unit of it is a design decision.
 *
 * `pathLength="100"` is declared on the element, so the dash animation in CSS is
 * a plain 100 → 0 and stays correct if these coordinates are ever retuned.
 */
export const TICK_PATH = "M -34 0 L -10 24 L 34 -24";

/**
 * Tick stroke width, in user units.
 *
 * 11 units renders ~17.7px at the mark's default size — "bold" rather than
 * "hairline", which is what carries a checkmark as the only object on a screen.
 * Round caps and joins add half of it past each endpoint, which the viewBox
 * margin above already covers.
 */
export const TICK_STROKE = 11;

/** Wing gradient id. Distinct from the loader's so the two marks can coexist
 *  for a frame during a React transition without colliding on a document id. */
const WING_GRADIENT_ID = "gnt-bfs-wing";

export interface ButterflySuccessOptions {
  /** Caption under the mark. Omitted → the mark alone, for screens that carry
   *  their own heading (every current call site but verification does). */
  label?: string;
  /**
   * Accessible name for the live region. Falls back to `label`; pass it
   * explicitly on a mark with no visible caption so the success is still
   * announced — the drawing is `aria-hidden`, so the mark is otherwise silent.
   */
  ariaLabel?: string;
}

/**
 * Markup for the success mark, as a string.
 *
 * One definition for both rails: the vanilla-TS apps drop this into
 * `innerHTML`, the React ones render it through `dangerouslySetInnerHTML`
 * (`butterfly-success-react.tsx`). Re-authoring it as JSX would give the mark
 * two definitions that drift apart — the exact note the loader carries, learned
 * the same way.
 *
 * `role="status"` sits on the wrapper rather than the SVG, so a screen reader
 * announces the caption when it appears while the drawing itself stays
 * decorative.
 *
 * Butterfly and tick share ONE svg and one viewBox rather than being stacked as
 * two: they are the same object at two moments, and one frame is what keeps the
 * point the butterfly shrinks into and the point the tick starts from in the
 * same coordinate space by construction rather than by two numbers agreeing.
 *
 * The two wings are separate paths because that is how `brand-butterfly.ts`
 * authors them (split at the body axis so a `scaleX` can fold them), and the
 * gradient is `userSpaceOnUse`, so the pair renders seamlessly as one shape.
 * This mark animates neither wing on its own; the loader is the one that does.
 *
 * The wings' paint server is referenced from an ATTRIBUTE, not from the
 * stylesheet, so the butterfly cannot render unpainted if the injected CSS lands
 * a frame late. The tick is the deliberate exception: its colour is the one
 * thing on this mark that differs per theme, so it has to come from CSS — and
 * carrying a hardcoded `stroke` attribute as a floor would be worse than not,
 * because without CSS there is no dash geometry either, so the fallback would
 * flash a COMPLETE tick and then rewind it. Unstroked-until-styled is the right
 * failure here: invisible for a frame, never wrong.
 */
export function butterflySuccessMarkup(options: ButterflySuccessOptions = {}): string {
  const { label, ariaLabel } = options;
  const announced = ariaLabel ?? label;
  const caption = label ? `<p class="bfs-label">${escapeHtml(label)}</p>` : "";
  const half = { x: VIEWBOX.width / 2, y: VIEWBOX.height / 2 };
  return (
    `<div class="bfs" role="status"${announced ? ` aria-label="${escapeHtml(announced)}"` : ""}>` +
    `<div class="bfs-mark">` +
    `<svg class="bfs-svg" viewBox="${-half.x} ${-half.y} ${VIEWBOX.width} ${VIEWBOX.height}"` +
    ` aria-hidden="true" focusable="false">` +
    `<defs>${logoWingGradient(WING_GRADIENT_ID)}</defs>` +
    `<g class="bfs-fly">` +
    `<path d="${WING_LEFT}" fill="url(#${WING_GRADIENT_ID})"/>` +
    `<path d="${WING_RIGHT}" fill="url(#${WING_GRADIENT_ID})"/>` +
    `</g>` +
    `<path class="bfs-tick" d="${TICK_PATH}" pathLength="100" fill="none"` +
    ` stroke-width="${TICK_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>` +
    `</div>` +
    caption +
    `</div>`
  );
}

/** DOM-node flavour, for call sites that build with `document.createElement`. */
export function butterflySuccess(options: ButterflySuccessOptions = {}): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = butterflySuccessMarkup(options);
  return host.firstElementChild as HTMLElement;
}

/** True when the viewer asked for less motion. Guarded for the test runner,
 *  which has no DOM at all. */
export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * How long is left until the tick has landed, for a mark mounted at `mountedAt`.
 *
 * Not every screen learns it succeeded at the moment it shows the mark.
 * Verification renders the mark and THEN waits on a network round-trip for the
 * verdict, so by the time it wants to buzz, the draw may be over already — and a
 * flat wait there would buzz long after the mark had settled. Clamped at zero,
 * so a slow response pulses immediately rather than negatively.
 */
export function settleDelayFrom(mountedAt: number, now: number = Date.now()): number {
  return Math.max(0, SUCCESS_ARRIVE_MS - (now - mountedAt));
}

/**
 * How long until the mark is fully at rest — tick drawn, bloom and caption
 * settled — for a mark mounted at `mountedAt`.
 *
 * The twin of `settleDelayFrom`, for the screens that DISMISS themselves rather
 * than buzz: a close scheduled off the wrong end of the animation is the one
 * failure mode here that the user experiences as the app eating its own
 * confirmation.
 */
export function restDelayFrom(mountedAt: number, now: number = Date.now()): number {
  return Math.max(0, SUCCESS_TOTAL_MS - (now - mountedAt));
}

/**
 * Runs `pulse` at the frame the tick finishes drawing.
 *
 * Every one of these screens already fires `HapticFeedback` — the point is
 * WHEN. Two of them (verification, the calendar) used to fire it before the
 * mark had been drawn at all, so the buzz arrived ahead of the picture and
 * confirmed nothing the user could see yet.
 *
 * Under reduced motion the mark is rendered already finished, so the pulse
 * belongs NOW; scheduling it later would buzz about something that stopped
 * moving before the user looked at it.
 *
 * @param mountedAt  When the mark went on screen, if that is not now. Omit for
 *                   the common case where the success and the mark arrive
 *                   together.
 * @returns A cancel, so a React unmount (or a screen that changes under the
 *          user) cannot buzz about a success that is no longer on screen.
 */
export function onSuccessSettle(pulse: () => void, mountedAt?: number): () => void {
  if (prefersReducedMotion()) {
    pulse();
    return () => {};
  }
  const delay = mountedAt === undefined ? SUCCESS_ARRIVE_MS : settleDelayFrom(mountedAt);
  const id = setTimeout(pulse, delay);
  return () => clearTimeout(id);
}
