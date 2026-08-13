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
 * thickening burgundy stroke — and then flies on out of frame, leaving the tick
 * behind it. The end state is a bold borderless burgundy tick and nothing else.
 *
 * The butterfly is the INSTRUMENT, not the subject, and that is a correction.
 * The first version had it land on the tick's tip and stay there with its wings
 * open, for brand presence. On screen that is the frame a user looks at for a
 * full second, and a logo perched on the point reads as a sticker stuck onto the
 * tick rather than as one mark — reported as "странно" and "некрасиво", which is
 * the correct reading of it. Leaving is also what the brief asked for in the
 * first place: a tick that is borderless, bold, and smoothly arrived at.
 *
 * Two consequences worth holding onto before anyone re-lands it:
 *  - The branded moment is the MOTION, not the resting frame. Nothing is added
 *    by holding the logo still at the end; the recognition is spent during the
 *    900ms the butterfly is drawing.
 *  - Leaving removes a fight the landing had with itself. To rest upright the
 *    flight had to unwind its bank over the last few percent, which reads as a
 *    swoop that stops and straightens. Flying out lets it keep the bank all the
 *    way, aligned with the tick's own 45° arm.
 *
 * Why a tick at all rather than a butterfly on its own: a tick is read as "done"
 * instantly and in every locale, and two of these screens are a PAYMENT and an
 * IDENTITY CHECK, where ambiguity is expensive. Why not a spinning logo: the
 * loading mark (`butterfly-loader.ts`) is already three butterflies flapping and
 * drifting, so a spinning butterfly would make "working" and "done" the same
 * picture.
 *
 * The two marks are deliberate siblings and deliberately different pictures.
 * The loader is butterflies INSIDE a waist — nerves, the feeling before. This
 * one has no waist at all: the butterfly is out, and it is gone. That is why the
 * belly paths are not imported here.
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
 * How long the butterfly takes to draw the tick, in ms.
 *
 * This is the moment the mark MEANS something: the stroke is complete, and it is
 * what call sites treat as "the tick landed" — the haptic fires here, not when
 * the butterfly has finished leaving. The exit that follows is a departure, and
 * buzzing about it would be buzzing about the instrument rather than the result.
 */
export const SUCCESS_FLIGHT_MS = 900;

/**
 * How long the butterfly takes to leave, once the tick is drawn.
 *
 * Short on purpose. It is a fade-out on a small element and must not compete for
 * attention with the tick that has just completed; long enough to read as flying
 * on, not long enough to become a second beat.
 */
export const SUCCESS_EXIT_MS = 300;

/**
 * Everything still moving after the tick is complete: the exit, and the bloom
 * and caption settling with it.
 *
 * Deliberately equal to `SUCCESS_EXIT_MS` rather than a hand-picked number — the
 * bloom (720ms + 480ms) and the caption (820ms + 380ms) are both timed to finish
 * at exactly the same frame the butterfly disappears, so the mark has one moment
 * of coming to rest instead of three. A test pins this against the stylesheet,
 * because the failure mode is a self-dismissing screen closing over a glow that
 * is still fading.
 */
export const SUCCESS_SETTLE_MS = SUCCESS_EXIT_MS;

/**
 * The whole beat, start to rest.
 *
 * Load-bearing for the two screens that DISMISS themselves: verification closes
 * the WebView on a timer, and a close that fires mid-flight shows the user a
 * half-drawn tick and nothing else. Those call sites derive their delay from
 * this rather than carrying a hand-tuned constant that silently stops matching
 * the animation.
 *
 * It is also the duration of BOTH the flight and the draw animations: they share
 * one timeline so the draw's stops stay directly comparable to the flight's (see
 * `FLIGHT_STOPS`). The draw simply reaches its last keyframe at
 * `DRAW_END_PCT` and holds.
 */
export const SUCCESS_TOTAL_MS = SUCCESS_FLIGHT_MS + SUCCESS_SETTLE_MS;

/**
 * Where the drawing finishes on that shared timeline, as a percentage.
 *
 * 75 exactly, which is why the durations are 900 + 300 rather than anything
 * finer: it keeps every rescaled keyframe stop a clean number, and a keyframe
 * percentage nobody can read is a keyframe nobody will re-derive correctly.
 */
export const DRAW_END_PCT = (SUCCESS_FLIGHT_MS / SUCCESS_TOTAL_MS) * 100;

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
export const CHECK_START = { x: 27, y: 62 } as const;
export const CHECK_VERTEX = { x: 53, y: 88 } as const;
export const CHECK_END = { x: 111, y: 30 } as const;

/**
 * The drawing surface.
 *
 * Sized so the TICK is centred in it — 22.25 units of margin left and right,
 * 25.25 top and bottom — because the tick is what rests here and the butterfly
 * is transient. It was 132 × 104 with the tick sitting 8 units left of centre,
 * which is what the frame being sized around a LANDED butterfly's wing cost.
 *
 * The extra height over the old 104 is headroom above the tip: the butterfly
 * flies `BUTTERFLY_LEAD` above the line and has to clear the ceiling there.
 */
export const VIEWBOX = { width: 138, height: 118 } as const;

/**
 * How far the butterfly flies ahead of the stroke's leading edge, in viewBox
 * units.
 *
 * Not decoration — it is what makes the drawing legible. Centred exactly ON the
 * tip (which is where it was) the butterfly overlapped the stroke it was
 * drawing, in the same hue, so it read as a lump on the line rather than as the
 * thing making it. Offset, the stroke emerges from behind its tail.
 *
 * The direction is "ahead along the path, and outside the bend", and for a tick
 * whose arms are both at 45° those two combine into something simpler: on the
 * dive they cancel vertically and leave a pure +x lead, on the up-sweep they
 * cancel horizontally and leave a pure −y one. That is why the authored
 * keyframes look like they offset on one axis at a time.
 *
 * 7 rather than the ~8.5 the geometry suggests, for one concrete reason: at 8.5
 * the butterfly's rotated box touches y=0 exactly at the tip keyframe, and an
 * SVG crops silently.
 */
export const BUTTERFLY_LEAD = 7;

/**
 * The butterfly's scale as it reaches the tick's tip — the largest it ever gets.
 *
 * Bounded by the frame, and the arithmetic is worth stating because an SVG crops
 * silently AND because the obvious version of it is wrong. The butterfly is
 * banked ~45° through the whole up-sweep, and a rotated box is much bigger than
 * the wings' own 88.6 × 63.4: at 45° both half-extents become
 * `(width + height) · cos45 · PEAK_SCALE / 2` ≈ 21.5.
 *
 * The binding edge is the TOP, not the right, which is the opposite of what it
 * looks like: the butterfly flies above a tip that already sits high in the
 * frame, so a bigger one is clipped by the ceiling long before it reaches the
 * right wall. 0.43 cleared the right wall and overran the ceiling.
 *
 * A test now walks EVERY authored keyframe — its own scale, its own rotation, its
 * own position — rather than checking this constant against one point, which is
 * the only version of the check that catches an offset the geometry moved.
 *
 * It stops growing a beat before the tip and holds, so the widest moment is never
 * the one closest to a frame edge.
 */
export const PEAK_SCALE = 0.4;

/**
 * The keyframe stops the flight and the draw SHARE, on the 1200ms timeline.
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
 * levelling-out. Same discipline as the onboarding icon-kill ramp, and for the
 * same reason — an eased constant-rate motion speeds up and then slows down
 * again, which reads as a wobble rather than as a deliberate swoop.
 *
 * They are the old 0…100 draw stops scaled by `DRAW_END_PCT`, which is what
 * makes the last one 75: the draw finishes there and holds, while the flight
 * carries on through `EXIT_STOPS`.
 */
export const FLIGHT_STOPS = [0, 10.5, 22.5, 34.5, 48, 61.5, 69, 75] as const;

/**
 * The exit segment's stops, starting at the shared boundary.
 *
 * `EXIT_STOPS[0]` is `DRAW_END_PCT` on purpose — it is the frame the stroke
 * closes on and the frame the departure begins on, one keyframe serving both, so
 * the two segments cannot drift apart by a stop. Only the ones after it are the
 * flight's alone.
 *
 * Three entries rather than two because the departure has to ACCELERATE: equal
 * time buys 5 units of travel to 87.5% and 10 to 100%, so the butterfly reads as
 * receding rather than drifting off. A single stop between 75 and 100 makes the
 * exit linear, which looks like the animation ran out rather than ended.
 */
export const EXIT_STOPS = [75, 87.5, 100] as const;

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
    `<svg class="bfs-svg" viewBox="0 0 ${VIEWBOX.width} ${VIEWBOX.height}" aria-hidden="true" focusable="false">` +
    `<defs>` +
    logoWingGradient(WING_GRADIENT_ID) +
    // Along the tick's own axis (across-the-frame endpoints would put the bright
    // end wherever the frame happened to be widest, which is not where the
    // motion is), running BRIGHT → DEEP.
    //
    // Light ink to heavy ink, matching the stroke-width ramp: the tick gets both
    // thicker and darker toward the tip, which is what "pressed harder as it was
    // drawn" looks like. The two have to agree — a stroke that thickens while
    // lightening reads as a highlight rather than as pressure.
    //
    // The RANGE is deliberately narrow, and that is the important part. It ran
    // #C82356 → #8B253B, which is a pink-to-burgundy sweep rather than one colour
    // with life in it, and looking at the finished mark it read as a PINK tick —
    // the brand accent is the burgundy end, and the bright end was winning.
    //
    // Narrowing it also fixes the butterfly, which is the less obvious half. The
    // logo's own gradient is dark in its upper lobes and bright magenta in its
    // lower one, so over a bright stroke the butterfly read as a dark smudge with
    // a stray bright dot — a lump on the line rather than an object above it.
    // Exactly one thing here gets to be the bright one, and it is the butterfly:
    // the trail it leaves is ink, and ink is the darker of the two.
    `<linearGradient id="${TRAIL_GRADIENT_ID}" gradientUnits="userSpaceOnUse"` +
    ` x1="${CHECK_START.x}" y1="${CHECK_START.y}" x2="${CHECK_END.x}" y2="${CHECK_END.y}">` +
    `<stop offset="0%" stop-color="#9C2B44"/>` +
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
 * How long is left until the tick is complete, for a mark mounted at
 * `mountedAt`.
 *
 * Not every screen learns it succeeded at the moment it shows the mark.
 * Verification renders the mark and THEN waits on a network round-trip for the
 * verdict, so by the time it wants to buzz, the drawing may have finished
 * already — and a flat 900ms wait there would buzz almost a second after the
 * tick was done. Clamped at zero, so a slow response pulses immediately
 * rather than negatively.
 */
export function settleDelayFrom(mountedAt: number, now: number = Date.now()): number {
  return Math.max(0, SUCCESS_FLIGHT_MS - (now - mountedAt));
}

/**
 * How long until the mark is fully at rest — the butterfly gone, the bloom and
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
 * Runs `pulse` at the frame the tick is complete.
 *
 * Every one of these screens already fires `HapticFeedback` — the point is
 * WHEN. Two of them (verification, the calendar) fired it before the mark had
 * even been drawn, so the buzz arrived ahead of the picture and confirmed
 * nothing the user could see yet. A single pulse as the stroke closes is what
 * makes the animation land as an event rather than as decoration.
 *
 * Deliberately NOT at the end of the exit: the departure is the instrument
 * leaving, and a buzz there would be about the butterfly rather than about the
 * result.
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
