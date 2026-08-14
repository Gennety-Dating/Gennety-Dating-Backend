/**
 * The shared success mark for every Mini App: the brand butterfly arrives.
 *
 * It springs in at full size, settles, and stays — that is the whole animation.
 * No path is traced, nothing crosses the frame, nothing leaves. The resting
 * frame is the Gennety logo with the screen's own heading under it.
 *
 * **There is no checkmark, and that was the decision the third round turned
 * on.** Two earlier versions had a butterfly draw a tick and then either land
 * on it (a logo perched on a point reads as a sticker) or fly out of frame
 * (which left a generic tick carrying no brand at all). Both were rejected, and
 * measuring the second one said why: the butterfly rendered **29 x 29 px** in
 * flight. The logo is an abstract four-lobe shape with no body, head or
 * antennae, so at that size it is a pink smudge — the argument that "the brand
 * moment is the MOTION" failed on its own terms, because the moving object was
 * never recognisable. The mark had removed the logo from the frame people look
 * at longest in exchange for a moment that did not exist.
 *
 * Dropping the tick is safe, and this was checked rather than assumed: all five
 * success surfaces already state the outcome in words. Verification passes
 * `label` into the mark itself; Type Radar, onboarding, venue-change and the
 * calendar each render their own heading directly beneath it. The tick was
 * duplicating the sentence beside it, not carrying meaning.
 *
 * **The consequence to hold onto:** the mark no longer says "success" on its
 * own — it says "Gennety", and the words say the rest. So a screen that renders
 * it with neither `label` nor a heading of its own turns it into decoration.
 * Every current call site has one; a sixth must too.
 *
 * The two brand marks stay deliberately different pictures. The loading mark
 * (`butterfly-loader.ts`) is three small butterflies flying inside a waist:
 * nerves, the feeling before. This one is a single butterfly at full size,
 * still: their resolution. `brand-butterfly.ts` owns the silhouette and the
 * gradient; `butterfly-success.css` owns motion and size.
 */

import "./butterfly-success.css";
import { WING_LEFT, WING_RIGHT, escapeHtml, logoWingGradient } from "./brand-butterfly.js";

/**
 * How long the butterfly takes to arrive, in ms.
 *
 * This is the moment the mark MEANS something, and what call sites treat as
 * "it landed" — the haptic fires here. Everything after it is the bloom and the
 * caption catching up, which nobody is waiting on.
 */
export const SUCCESS_ARRIVE_MS = 520;

/**
 * Everything still moving after the butterfly has landed: the bloom behind it
 * and the caption below.
 *
 * A test pins this against the stylesheet, because both are declared there as
 * delay-plus-duration pairs and the failure mode is a self-dismissing screen
 * closing over a glow that is still rising.
 */
export const SUCCESS_SETTLE_MS = 180;

/**
 * The whole beat, start to rest.
 *
 * Load-bearing for the two screens that DISMISS themselves: verification closes
 * the WebView on a timer and Type Radar closes after its save, and a close
 * fired mid-animation shows the user a half-arrived mark. Those call sites
 * derive their delay from this rather than carrying a hand-tuned constant that
 * silently stops matching the animation.
 *
 * It is 700ms against the drawn tick's 1200ms, so those screens now close about
 * half a second sooner. That is a direct consequence of a simpler animation
 * rather than an oversight — but it is the one number to revisit first if the
 * verification success ever starts feeling rushed.
 */
export const SUCCESS_TOTAL_MS = SUCCESS_ARRIVE_MS + SUCCESS_SETTLE_MS;

/**
 * How long a mark that has come to rest is held before a self-dismissing screen
 * closes over it.
 *
 * Deliberately unchanged from the drawn-tick era: `SUCCESS_TOTAL_MS` answers
 * "when does it stop moving", this answers "how long does a person need to see
 * that it did", and the second question is not affected by the first getting
 * shorter.
 */
export const SUCCESS_READ_MS = 1100;

/**
 * The largest the butterfly ever gets, at the top of the arrival overshoot.
 *
 * Exported because the viewBox has to contain it and an SVG crops silently. A
 * test walks it against `VIEWBOX`; the breath that follows peaks lower, so this
 * one constant bounds the whole animation.
 */
export const POP_PEAK_SCALE = 1.045;

/**
 * The drawing surface.
 *
 * The wings' own bbox is 88.63 x 63.44 around the origin, so half-extents at
 * `POP_PEAK_SCALE` are 46.3 and 34.0. 104 x 76 clears both with a couple of
 * units to spare and keeps the mark close to square, which is what lets the
 * bloom behind it stay a circle rather than an ellipse.
 */
export const VIEWBOX = { width: 104, height: 76 } as const;

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
   * announced — on those screens the heading beside it is what a sighted user
   * reads, and the mark itself is silent otherwise.
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
 * The two wings are separate paths because that is how `brand-butterfly.ts`
 * authors them (split at the body axis so a `scaleX` can fold them), and the
 * gradient is `userSpaceOnUse`, so the pair renders seamlessly as one shape
 * with no per-wing group needed here. This mark animates neither wing on its
 * own; the loader is the one that does.
 *
 * The paint server is referenced from an ATTRIBUTE, not from the stylesheet, so
 * the mark cannot render unpainted if the injected CSS lands a frame late.
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
 * How long is left until the butterfly has landed, for a mark mounted at
 * `mountedAt`.
 *
 * Not every screen learns it succeeded at the moment it shows the mark.
 * Verification renders the mark and THEN waits on a network round-trip for the
 * verdict, so by the time it wants to buzz, the arrival may be over already —
 * and a flat wait there would buzz long after the mark had settled. Clamped at
 * zero, so a slow response pulses immediately rather than negatively.
 */
export function settleDelayFrom(mountedAt: number, now: number = Date.now()): number {
  return Math.max(0, SUCCESS_ARRIVE_MS - (now - mountedAt));
}

/**
 * How long until the mark is fully at rest — butterfly landed, bloom and
 * caption settled — for a mark mounted at `mountedAt`.
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
 * WHEN. Two of them (verification, the calendar) used to fire it before the
 * mark had been drawn at all, so the buzz arrived ahead of the picture and
 * confirmed nothing the user could see yet.
 *
 * Under reduced motion the mark is rendered already arrived, so the pulse
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
