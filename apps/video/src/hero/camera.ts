import {Easing} from "remotion";
import type {Lang} from "./timeline";

/**
 * The camera. One of them, for the whole film, and it does exactly one thing:
 * it moves toward the phone.
 *
 * This module is the entire motion system of `GennetyHero`. Everything the
 * viewer sees move is a value read out of the table below at an **absolute
 * composition frame** — never a scene-local one, because a scene-local camera is
 * exactly what produced the reset this replaced (`../../motion-audit.md`).
 *
 *   THE CAMERA DOES NOT KNOW WHERE THE CUTS ARE.
 *
 * `cameraAt()` takes a frame and nothing else, so
 * `camera(last frame of A) === camera(first frame of B)` holds by construction
 * rather than by anyone keeping two numbers in step.
 *
 * ---
 *
 * The frame numbers below are absolute and therefore move whenever the CUT
 * does. They were re-spaced three times in three days (2026-08-19, and twice on
 * 2026-08-21), and the shape — six held distances, five slow steps, monotone —
 * survived all three, as did the 0.88 … 1.24 range. Re-run `camera.probe.ts`
 * after any re-space; it is what proves that.
 *
 * **The table ends with the WORLD, not with the film.** The last beat sits on
 * `timeline.ts`'s `WORLD_END` — the final frame any footage is on screen — and
 * the 543 frames of drawn title act after it are governed by `titleTransform`
 * below instead. A dolly needs something to approach; a title card is not it.
 *
 * ## The one rule this file exists to enforce (founder, 2026-08-18)
 *
 * **The phone is static. Only the camera approaches or retreats.**
 *
 * That is stricter than it sounds, and it killed two things that were here
 * before:
 *
 * 1. **No lateral or vertical movement at all.** `x` and `y` are gone, not set
 *    to zero — a phone sliding around the frame is a phone that is moving,
 *    whichever object the code says is doing it. This restores the 2026-08-16
 *    founder decision in full; the previous pass had reintroduced a ±39 px
 *    drift by calling it camera work.
 *
 * 2. **The zoom never reverses.** The previous pass ran the handset
 *    545 → 647 → 583 → 723 → 786 → **558** → 660 → 609 → 761 px: six changes of
 *    direction, and at 29 s it was back to within 13 px of where it started.
 *    The founder's words for that were «увеличивается, потом обратно в одну
 *    секунду возвращается в исходное положение» — and they are a fair reading
 *    of the numbers, because a framing the film already used cannot read as
 *    progress. A camera that walks toward an object and sometimes walks back is
 *    not a camera, it is a rhythm.
 *
 * So this is a **dolly straight down the lens axis**: nine seconds still, a slow
 * step closer, still again. 558 px to 786 px over 47 seconds, one direction,
 * and every framing in the film is one the film has not used before.
 *
 * ## Two cuts (2026-08-23)
 *
 * `BEATS` is keyed by language, because its frame numbers are ABSOLUTE and
 * therefore move whenever the cut does — and the English cut ends its world at
 * 1280 rather than 1323. What is keyed is the table, not the system: `locate`,
 * `EASE`, `TITLE_CREEP` and both rules below are shared, and `camera.probe.ts`
 * is run for both languages precisely so neither table can drift out of shape.
 *
 * The English table is the Ukrainian one re-spaced, not re-designed: six held
 * distances, five slow steps, the same 0.88 … 1.24 range, monotone, ~60 % held,
 * and every step placed inside a shot or crossing a cut mid-flight.
 *
 * `camera.probe.ts` fails if either rule is broken.
 */

/** A point in the film's one and only coordinate system. */
export type CameraState = {
  /**
   * Distance, as the scale the world is drawn at. At 1.0 the phone screen
   * renders 604 px wide — a 1.05x blow-up of the 576 px source. The film runs
   * 0.88 … 1.24, so the worst upscale is ~1.30x.
   *
   * The ceiling is the frame, not the resolution: the handset is never cropped
   * (founder, 2026-08-17), so 1.24 already leaves only ~110 px of vertical air.
   * The reference affords 5x by cropping in 85% of its frames; that is the
   * trade being declined, and it is why this range is modest.
   */
  scale: number;
  /**
   * Roll, degrees. **Always 0.** Kept as a field because a camera has one; the
   * phone is never tilted per beat (founder, 2026-08-16).
   */
  rotate: number;
};

/**
 * The move between two holds.
 *
 * **Fitted to the founder's reference, not chosen.** Its two cleanest camera
 * moves were tracked frame by frame, normalised, and a cubic-bezier easing was
 * least-squares fitted over a constrained monotone search. Scores, lower is
 * better: this curve **0.053**, quad-out 0.067, cubic-out 0.086, the film's own
 * `ease` 0.178, a symmetric ease-in-out 0.251 (the worst of everything tried).
 *
 * The refinement over the first fit is the **launch slope: 0.67**, against 1.00
 * for the unconstrained best and 4.5 for the film's old `ease`. Constraining the
 * search to a gentle launch cost essentially nothing (RMS 0.0529 vs 0.0525) and
 * buys a move that eases IN as well as out — so leaving a hold has no velocity
 * step at all, which is the last place a "рывок" could hide.
 */
const EASE = Easing.bezier(0.18, 0.12, 0.2, 0.96);

export type Beat = {
  /** The camera is DEAD STILL across this inclusive frame range. */
  hold: readonly [number, number];
  scale: number;
  /** Halo strength — held and moved with the framing, not stepped per shot. */
  glow: number;
  note: string;
};

/**
 * The dolly. Six held distances, five slow steps between them, ending with the
 * world — the title act after it has its own creep (`titleTransform`).
 *
 * Monotone by construction and by test: 558 → 609 → 666 → 710 → 755 → 786 px of
 * handset. Each step is ~45 px over ~3 s — about 0.5 px per frame, roughly four
 * times gentler than the pass before this one, and the film never revisits a
 * distance it has already been at.
 *
 * 61% of the film is held. The rest is these five steps, and each is
 * placed to sit INSIDE a shot or to cross a cut mid-flight — never to start on
 * one, because a move that begins exactly when the screen changes reads as the
 * cut having caused it.
 *
 * The film therefore builds toward the date card, which is both the last beat
 * and the closest the camera ever gets. That is the whole shape.
 */
const BEATS_UK = [
  {
    hold: [0, 210],
    scale: 0.88,
    glow: 0.78,
    note: "Establish and stay there — the name, the age slider, the gender tap.",
  },
  {
    hold: [300, 540],
    scale: 0.96,
    glow: 0.82,
    note: "One step closer for the photo columns, the height drum, the question.",
  },
  {
    hold: [640, 830],
    scale: 1.05,
    glow: 0.86,
    note: "Closer again as the radar closes and the film turns on the decision.",
  },
  {
    hold: [930, 1010],
    scale: 1.12,
    glow: 0.92,
    note: "The butterfly, «вівторок, 25 серп. 17:00», and the address search opening.",
  },
  {
    hold: [1140, 1240],
    scale: 1.19,
    glow: 0.96,
    note: "The vibe typed out and read back — the venue act, held.",
  },
  {
    hold: [1323, 1323],
    scale: 1.24,
    glow: 1.0,
    note: "Still moving in as the world hands over. The film does not park.",
  },
] as const satisfies readonly Beat[];

/**
 * The English dolly. Same shape and the same 0.88 … 1.24, re-spaced for a world
 * that ends 57 frames earlier.
 *
 * **Re-spaced against the ENGLISH cut's own boundaries, then checked, rather
 * than scaled from the Ukrainian table.** A proportional squeeze is the obvious
 * move and it is wrong here: the two cuts did not shorten evenly — the radar
 * lost 34 frames and `basics-preference` 41 while the calendar act lost none —
 * so a uniform factor would drop steps onto cuts that moved by different
 * amounts.
 *
 * The English boundaries are 78, 156, 228, 271, 355, 445, 525, 603, 637, 741,
 * 780, 843, 919, 997, 1048, 1130, 1170. Every hold edge below sits strictly
 * inside a shot, so no move starts, ends, or is held from the exact frame a
 * screen changes — a move that begins when the picture cuts reads as the cut
 * having caused it. Each step then crosses one or more cuts mid-flight, which
 * is the point.
 *
 * `camera.probe.ts` measures the result rather than trusting this note: 62% of
 * the world held, launch at 0.76x the move's own average, zero reversals, and
 * the worst camera step at any cut 0.92 px of handset.
 */
const BEATS_EN = [
  {
    hold: [0, 202],
    scale: 0.88,
    glow: 0.78,
    note: "Establish and stay there — the name, the age slider, the gender tap.",
  },
  {
    hold: [289, 520],
    scale: 0.96,
    glow: 0.82,
    note: "One step closer for the photo columns, the height drum, the question.",
  },
  {
    hold: [616, 799],
    scale: 1.05,
    glow: 0.86,
    note: "Closer again as the radar closes and the film turns on the decision.",
  },
  {
    hold: [896, 973],
    scale: 1.12,
    glow: 0.92,
    note: "The butterfly, «Wednesday 26 Aug 17:00», and the address search opening.",
  },
  {
    hold: [1098, 1194],
    scale: 1.19,
    glow: 0.96,
    note: "The vibe typed out and read back — the venue act, held.",
  },
  {
    hold: [1266, 1266],
    scale: 1.24,
    glow: 1.0,
    note: "Still moving in as the world hands over. The film does not park.",
  },
] as const satisfies readonly Beat[];

const BEATS: Record<Lang, readonly Beat[]> = {uk: BEATS_UK, en: BEATS_EN};

/** Where `frame` sits: inside a hold, or `t` of the way through a step. */
const locate = (frame: number, lang: Lang) => {
  const beats = BEATS[lang];
  if (frame <= beats[0].hold[1]) return {beats, a: 0, b: 0, t: 0};
  for (let i = 0; i < beats.length - 1; i++) {
    if (frame <= beats[i].hold[1]) return {beats, a: i, b: i, t: 0};
    const from = beats[i].hold[1];
    const to = beats[i + 1].hold[0];
    if (frame < to) return {beats, a: i, b: i + 1, t: EASE((frame - from) / (to - from))};
  }
  return {beats, a: beats.length - 1, b: beats.length - 1, t: 0};
};

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** The camera at an absolute composition frame. The film's only source of motion. */
export const cameraAt = (frame: number, lang: Lang): CameraState => {
  const {beats, a, b, t} = locate(frame, lang);
  return {scale: mix(beats[a].scale, beats[b].scale, t), rotate: 0};
};

/**
 * The halo behind the handset.
 *
 * It used to be a per-shot constant, which stepped the light on a stationary
 * object at eight of the fourteen cuts. It rides the beats now — as still as
 * the camera is, and moving only when the camera does.
 */
export const glowAt = (frame: number, lang: Lang): number => {
  const {beats, a, b, t} = locate(frame, lang);
  return mix(beats[a].glow, beats[b].glow, t);
};

/** Frame ranges the camera is completely still for. Read by the probe. */
export const cameraHolds = (lang: Lang): readonly (readonly [number, number])[] =>
  BEATS[lang].map((b) => b.hold);

/**
 * The title act's own creep, as a ready-made CSS transform.
 *
 * **The camera above governs the WORLD, and ends with it** (its last beat is
 * the last frame any footage is on screen). Everything after that is drawn
 * type, and a phone-dolly is the wrong instrument for it — there is no phone to
 * dolly toward. What survives from the mark's old rule is its intent, which was
 * never about the dolly: *the film must not park*. A title card holding dead
 * still for four seconds is a slide, not a shot.
 *
 * So each card creeps 3.2 % across its own life, and — this is the part that
 * matters — **relative to its OWN start, not to the act's**. Two of the cards
 * open on the same two words, and if the second one inherited an act-wide drift
 * it would render those words 1–2 % larger than the first. At that size the eye
 * reads the difference as a mistake rather than as motion, and the anaphora
 * (`titles.ts` → SETUP) is the one thing in the act that has to be exact.
 *
 * Linear, not eased: a creep with an ease-in has a visible start, which is the
 * opposite of what a creep is for.
 *
 * This replaces `relativeCameraTransform`, which the mark used to read the
 * world camera through. That was correct while the mark crossfaded straight out
 * of the world; it no longer does — four cards sit in between.
 */
const TITLE_CREEP = 0.032;

export const titleTransform = (frame: number, duration: number): string => {
  const t = duration <= 1 ? 0 : Math.min(1, Math.max(0, frame / (duration - 1)));
  return `scale(${(1 + TITLE_CREEP * t).toFixed(5)})`;
};
