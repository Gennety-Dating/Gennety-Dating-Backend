/**
 * "The butterfly draws the tick" — the shared success mark for every Mini App.
 *
 * Replaces four unrelated checkmarks that had grown up independently: a green
 * disc with a white tick (verification), an 84px burgundy stroke that drew
 * itself (calendar), a white disc with a BLACK tick (Type Radar), and a 76px
 * burgundy gradient disc with a white tick (venue change). Same moment, same
 * product, four different pictures — which is the whole reason this module
 * exists.
 *
 * The mark is one butterfly flying the checkmark's own path: it enters small and
 * banked, dives through the vertex, sweeps up to the right trailing a
 * thickening burgundy stroke, then levels out and lands on the tip with its
 * wings open. The end state is a bold borderless tick with the logo sitting at
 * its point.
 *
 * Why this rather than a butterfly on its own: a tick is read as "done"
 * instantly and in every locale, and two of these screens are a PAYMENT and an
 * IDENTITY CHECK, where ambiguity is expensive. Why this rather than a spinning
 * logo: the loading mark (`butterfly-loader.ts`) is already three butterflies
 * flapping and drifting, so a spinning butterfly would make "working" and
 * "done" the same picture.
 *
 * The two marks are deliberate siblings and deliberately different pictures.
 * The loader is butterflies INSIDE a waist — nerves, the feeling before. This
 * one has no waist at all: the butterfly is out, and it has landed. That is why
 * the belly paths are not imported here.
 *
 * Colour is burgundy, not green. The tick's legibility comes from its SHAPE,
 * and green would be the only green in the product — it would read as a system
 * dialog rather than as Gennety. `brand-butterfly.ts` owns the silhouette;
 * `butterfly-success.css` owns motion and colour.
 */

import "./butterfly-success.css";
import {
  WING_LEFT,
  WING_RIGHT,
  escapeHtml,
  logoWingGradient,
} from "./brand-butterfly.js";

/**
 * How long the butterfly is in flight, in ms. Must equal the `bfs-flight` /
 * `bfs-draw` durations in the stylesheet — a test asserts it, because the
 * number's other job is telling call sites when the landing happens.
 */
export const SUCCESS_FLIGHT_MS = 900;

/**
 * The bloom + caption settling after the landing.
 *
 * Sized to the LAST thing still moving, which is the bloom: it starts at 760ms
 * and runs 520ms, so the mark is not at rest until 1280ms. A tempting 260 here
 * (the gap to the caption finishing) is the kind of number that reads fine and
 * then lets a self-dismissing screen cut the glow off mid-fade — a test pins it
 * against the stylesheet rather than against anyone's estimate.
 */
export const SUCCESS_SETTLE_MS = 380;

/**
 * The whole beat, start to rest.
 *
 * Load-bearing for the two screens that DISMISS themselves: verification closes
 * the WebView on a timer, and a close that fires mid-flight shows the user a
 * half-drawn tick and nothing else. Those call sites derive their delay from
 * this rather than carrying a hand-tuned constant that silently stops matching
 * the animation.
 */
export const SUCCESS_TOTAL_MS = SUCCESS_FLIGHT_MS + SUCCESS_SETTLE_MS;

/**
 * How long a mark that has come to rest is held before a self-dismissing screen
 * closes over it.
 *
 * Separate from the animation on purpose: `SUCCESS_TOTAL_MS` answers "when does
 * it stop moving", this answers "how long does a person need to see that it
 * did". Only the screens that close themselves consume it.
 */
export const SUCCESS_READ_MS = 1100;

/**
 * The tick's three points, in viewBox units.
 *
 * Exported because they are shared by three things that must agree: the `d`
 * attribute below, the trail gradient's endpoints (so the stroke deepens ALONG
 * its own direction rather than across the frame), and the flight keyframes in
 * the stylesheet. Two of those live in CSS, so the test checks them against
 * these.
 */
export const CHECK_START = { x: 20, y: 54 } as const;
export const CHECK_VERTEX = { x: 46, y: 80 } as const;
export const CHECK_END = { x: 104, y: 22 } as const;

/**
 * The butterfly's scale where it lands.
 *
 * Sized so the landed wings clear the viewBox: at 0.45 the butterfly is
 * `WING_BBOX.width * 0.45` ≈ 39.9 wide, centred on `CHECK_END`, which keeps its
 * right wingtip 8 units inside the 132-wide frame. Raising it crops a wing —
 * and an SVG crops silently, which is why a test does this arithmetic.
 *
 * There is a ceiling here that is NOT about the frame, and it is worth knowing
 * before anyone "makes the logo bigger": the mark was reviewed at 0.40 / 0.58 /
 * 0.74 / 0.90, and past roughly 0.5 the butterfly stops reading as a signature
 * on the tick and starts reading as the subject, at which point the tick looks
 * like an underline for it. The logo is also an abstract four-lobe shape rather
 * than a naturalistic butterfly, so scale buys recognition only up to a point.
 */
export const LANDED_SCALE = 0.45;

/**
 * The keyframe stops the flight and the draw SHARE.
 *
 * This is the one number set that cannot drift. The butterfly's position and
 * the stroke's `stroke-dashoffset` are two separate animations on two separate
 * elements, and the illusion — that the butterfly is laying the stroke down
 * behind it — holds only while they progress identically. Give them different
 * stops (or, worse, a different easing) and the stroke tip visibly separates
 * from the butterfly somewhere in the middle of the sweep.
 *
 * Both run `linear`, so the acceleration lives in the SPACING of these stops
 * rather than in an easing curve: tight through the dive, loose into the
 * landing. Same discipline as the onboarding icon-kill ramp, and for the same
 * reason — an eased constant-rate motion speeds up and then slows down again,
 * which reads as a wobble rather than as a deliberate swoop.
 */
export const FLIGHT_STOPS = [0, 14, 30, 46, 64, 82, 92, 100] as const;

/** Wing gradient id. Distinct from the loader's so the two marks can coexist
 *  for a frame during a React transition without colliding on a document id. */
const WING_GRADIENT_ID = "gnt-bfs-wing";
/** Trail gradient id. */
const TRAIL_GRADIENT_ID = "gnt-bfs-trail";

export interface ButterflySuccessOptions {
  /** Caption under the mark. Omitted → the mark alone, for screens that carry
   *  their own heading (all four replaced ones do). */
  label?: string;
  /**
   * Accessible name for the live region. Falls back to `label`; pass it
   * explicitly on a mark with no visible caption so the success is still
   * announced — on these screens the mark IS the confirmation.
   */
  ariaLabel?: string;
}

/**
 * Markup for the success mark, as a string.
 *
 * One definition for both rails: the vanilla-TS apps drop this into
 * `innerHTML`, the React ones render it through `dangerouslySetInnerHTML`
 * (`butterfly-success-react.tsx`). Re-authoring it as JSX would give the
 * animation two definitions that drift apart — the exact note the loader
 * carries, learned the same way.
 *
 * `role="status"` sits on the wrapper rather than the SVG, so a screen reader
 * announces the caption when it appears while the drawing itself stays
 * decorative.
 *
 * The paint servers are referenced from ATTRIBUTES, not from the stylesheet, so
 * the mark cannot render unpainted if the injected CSS lands a frame late.
 */
export function butterflySuccessMarkup(options: ButterflySuccessOptions = {}): string {
  const { label, ariaLabel } = options;
  const announced = ariaLabel ?? label;
  const caption = label ? `<p class="bfs-label">${escapeHtml(label)}</p>` : "";
  const d = `M ${CHECK_START.x} ${CHECK_START.y} L ${CHECK_VERTEX.x} ${CHECK_VERTEX.y} L ${CHECK_END.x} ${CHECK_END.y}`;
  return (
    `<div class="bfs" role="status"${announced ? ` aria-label="${escapeHtml(announced)}"` : ""}>` +
    `<div class="bfs-mark">` +
    `<svg class="bfs-svg" viewBox="0 0 132 104" aria-hidden="true" focusable="false">` +
    `<defs>` +
    logoWingGradient(WING_GRADIENT_ID) +
    // Along the tick's own axis (across-the-frame endpoints would put the bright
    // end wherever the frame happened to be widest, which is not where the
    // motion is), running BRIGHT → DEEP.
    //
    // That direction is the opposite of the intuitive one and was settled by
    // looking at it: deep → bright puts the stroke's brightest point exactly
    // where the butterfly lands, and since the logo's own magenta sits on its
    // lower edge, the two merged into a single bright blob — the butterfly read
    // as a thickening of the line rather than as an object on it. Deepening
    // toward the tip is what separates them.
    `<linearGradient id="${TRAIL_GRADIENT_ID}" gradientUnits="userSpaceOnUse"` +
    ` x1="${CHECK_START.x}" y1="${CHECK_START.y}" x2="${CHECK_END.x}" y2="${CHECK_END.y}">` +
    `<stop offset="0%" stop-color="#C82356"/>` +
    `<stop offset="100%" stop-color="#8B253B"/>` +
    `</linearGradient>` +
    `</defs>` +
    // pathLength="100" normalises the dash arithmetic, so the stylesheet's
    // dashoffset stops are plain percentages of the stroke. Without it every
    // stop would be a hand-computed multiple of the real path length (~118.8
    // units) and tweaking the tick's geometry would silently desynchronise the
    // draw from the flight.
    `<path class="bfs-trail" pathLength="100" d="${d}"` +
    ` fill="none" stroke="url(#${TRAIL_GRADIENT_ID})" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<g class="bfs-fly">` +
    `<g class="bfs-wing"><path d="${WING_LEFT}" fill="url(#${WING_GRADIENT_ID})"/></g>` +
    `<g class="bfs-wing"><path d="${WING_RIGHT}" fill="url(#${WING_GRADIENT_ID})"/></g>` +
    `</g>` +
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
 * How long is left until the landing, for a mark mounted at `mountedAt`.
 *
 * Not every screen learns it succeeded at the moment it shows the mark.
 * Verification renders the mark and THEN waits on a network round-trip for the
 * verdict, so by the time it wants to buzz, the flight may have finished
 * already — and a flat 900ms wait there would buzz almost a second after the
 * butterfly stopped. Clamped at zero, so a slow response pulses immediately
 * rather than negatively.
 */
export function settleDelayFrom(mountedAt: number, now: number = Date.now()): number {
  return Math.max(0, SUCCESS_FLIGHT_MS - (now - mountedAt));
}

/**
 * How long until the mark is fully at rest (bloom included), for a mark mounted
 * at `mountedAt`.
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
 * Runs `pulse` at the frame the butterfly lands.
 *
 * Every one of these screens already fires `HapticFeedback` — the point is
 * WHEN. Two of them (verification, the calendar) fired it before the mark had
 * even been drawn, so the buzz arrived ahead of the picture and confirmed
 * nothing the user could see yet. A single pulse on the landing is what makes
 * the animation land as an event rather than as decoration.
 *
 * Under reduced motion the mark is drawn already finished, so the pulse belongs
 * NOW; scheduling it 900ms later would buzz about something that stopped moving
 * before the user looked at it.
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
  const delay = mountedAt === undefined ? SUCCESS_FLIGHT_MS : settleDelayFrom(mountedAt);
  const id = setTimeout(pulse, delay);
  return () => clearTimeout(id);
}
