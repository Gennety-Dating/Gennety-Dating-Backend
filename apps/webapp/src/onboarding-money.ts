/**
 * Banknotes drifting down through intro scene 2 ("what does it cost to find a
 * relationship in 2026?").
 *
 * That scene was the only one of the first three with nothing but type: scene 0
 * raises the competitor icons, scene 1 crumbles them, and this one — the screen
 * that actually asks the money question — held a line and moved on. The money
 * is the answer-shaped image the question was missing.
 *
 * Five constraints, each of which decided something below:
 *
 *  - **Deterministic, never `Math.random()`.** Same rule `preference-layout.ts`
 *    states for the preference scatter and `onboarding-crumble.ts` for the
 *    tiles: a pattern re-rolled per render can never be reviewed twice and no
 *    test can pin it. Every value here comes from `seededNoise`.
 *  - **It falls, it does not rain.** The screen asks what this COSTS, so the
 *    money leaves downward, with weight. Fourteen notes, spread across three
 *    depths — never a jackpot shower, which reads as winning and is the
 *    opposite claim.
 *  - **It was already falling.** Every note starts at a negative offset into
 *    its own loop, so the frame is populated top to bottom the instant the
 *    fall begins. The first build emitted them all from above the top edge and
 *    the screen filled like a curtain, leaving the bottom half empty for a
 *    second — visible in the very first screenshot of it. This became
 *    load-bearing rather than merely nicer once the fall was moved to start
 *    with the SCENE (it used to wait for the question to finish typing): the
 *    frame has to be full on the first frame the user sees, because there is no
 *    longer a couple of seconds of typing for a curtain to fill during.
 *  - **Paper flutters; rubble drops.** This sits one screen after the icon
 *    crumble, so "things falling" is the second use of that verb in a row. What
 *    separates them is physics rather than styling: a tile falls on a straight
 *    ease-in, a banknote tumbles about its long axis and goes edge-on twice a
 *    second. That tumble is the whole reason this doesn't read as a repeat.
 *  - **Every note stays BEHIND the copy.** Depth comes from size, opacity, blur
 *    and speed, never from crossing the words: the question is what the screen
 *    is for, and on a 390px phone `.hook-main` (28rem) leaves no outer margin a
 *    near-layer note could pass through without landing on type.
 *  - **The scene cuts mid-fall on purpose.** `MONEY_VIEW_MS` is shorter than
 *    `MONEY_LOOP_MS` and `.scene-stage` crossfades over 420ms, so the notes are
 *    still coming down as the stats screen — the ANSWER to this question —
 *    fades in over them.
 *
 * Rendering (`MoneyFall` in onboarding.tsx) only reads these numbers into CSS
 * custom properties; all motion is keyframes in onboarding.css, so the notes
 * animate on the compositor and this module stays testable with no DOM.
 */

import { lerp, round2, seededNoise } from "./seeded-noise.js";

/** Far / mid / near. Index doubles as the seed salt, so layers differ. */
export type MoneyLayer = 0 | 1 | 2;

interface LayerSpec {
  count: number;
  /** Multiplier on the CSS base note width. */
  scale: number;
  opacity: number;
  /** Only the near layer is blurred — `filter` is the expensive one, and three
   *  elements is a depth-of-field cue, fourteen is a frame rate problem. */
  blurPx: number;
  fallMsMin: number;
  fallMsMax: number;
  /** Tumble period. Nearer paper reads as tumbling faster. */
  spinMsMin: number;
  spinMsMax: number;
}

const LAYERS: readonly LayerSpec[] = [
  // Far: small, dim, slow. Ambience.
  { count: 6, scale: 0.54, opacity: 0.32, blurPx: 0, fallMsMin: 4200, fallMsMax: 5200, spinMsMin: 2600, spinMsMax: 3600 },
  // Mid: the layer actually read as "banknotes".
  { count: 5, scale: 0.86, opacity: 0.58, blurPx: 0, fallMsMin: 3100, fallMsMax: 3900, spinMsMin: 1900, spinMsMax: 2700 },
  // Near: large, blurred, quick — foreground depth of field. Faint and heavily
  // defocused ON PURPOSE: at 0.34/2.2px one of these passed across "найти
  // отношения" and washed the line out (caught on a stepped frame). It cannot
  // be kept off the text — it falls through the whole frame — so it has to be
  // bokeh rather than an object.
  { count: 3, scale: 1.35, opacity: 0.24, blurPx: 3.2, fallMsMin: 2300, fallMsMax: 2900, spinMsMin: 1500, spinMsMax: 2100 },
];

/** Horizontal band the notes start in, % of the viewport. Inset so a note is
 *  never born half-clipped against an edge. */
const X_MIN_PCT = 6;
const X_MAX_PCT = 94;

/** Sideways drift over the whole fall, vw. Small — this is air, not wind. */
const DRIFT_VW = 7;

/** Static in-plane tilt, deg either way. Applied on the note itself so it does
 *  not fight the tumble on the wrapper above it. */
const TILT_DEG = 26;

/** Per-note size jitter within its layer, so a layer is not three clones. */
const SCALE_JITTER = 0.16;

/** Band the notes rest in under `prefers-reduced-motion`, vh. Kept clear of the
 *  vertical centre, where the question sits. */
const REST_VH_MIN = 8;
const REST_VH_MAX = 88;

/**
 * How much of its own loop a layer's notes are spread across at birth, 0..1.
 *
 * At 1 the layer is a perfectly even column of notes, which reads as a
 * mechanical conveyor; a shade under leaves the spacing uneven the way real
 * falling paper is.
 */
const PHASE_SPREAD = 0.92;

export interface Bill {
  layer: MoneyLayer;
  /** Start position, % of viewport width. */
  xPct: number;
  /** Sideways travel over the fall, vw. */
  driftVw: number;
  /**
   * Offset into the loop at birth — NEGATIVE for most notes, which is what
   * starts them already part-way down.
   *
   * Without it every note enters from above the top edge together and the
   * screen fills from the top like a curtain, leaving the lower half empty for
   * the first second (measured on the first build, not predicted). A negative
   * `animation-delay` starts a note mid-fall, so the money reads as having
   * been falling before the question finished typing.
   */
  phaseMs: number;
  durationMs: number;
  /** One full tumble about the long axis. */
  spinMs: number;
  /** Offset into the tumble at birth, so notes are not all edge-on together. */
  spinDelayMs: number;
  tiltDeg: number;
  scale: number;
  opacity: number;
  blurPx: number;
  /**
   * Where the note rests under `prefers-reduced-motion`, vh from the top.
   *
   * Seeded here rather than left to CSS so the reduced-motion screen is a
   * COMPOSITION — notes scattered down the frame — instead of fourteen of them
   * stacked on one line, which is what a single constant in the stylesheet
   * would have produced.
   */
  restVh: number;
}

/**
 * Every note, far layer first so the DOM order is also the paint order — the
 * near layer must land on top of the far one, and neither may need a z-index
 * to say so.
 */
export function moneyBills(): Bill[] {
  const bills: Bill[] = [];

  LAYERS.forEach((spec, layerIndex) => {
    for (let i = 0; i < spec.count; i += 1) {
      // Separate salts per property: draw them from one number and size,
      // speed and position all correlate, which is what made the first
      // crumble land as a single horizontal smear.
      const nX = seededNoise(layerIndex, i, 1);
      const nDrift = seededNoise(layerIndex + 7, i, 2);
      const nPhase = seededNoise(layerIndex + 13, i, 3);
      const nFall = seededNoise(layerIndex + 23, i, 4);
      const nSpin = seededNoise(layerIndex + 31, i, 5);
      const nSpinOff = seededNoise(layerIndex + 43, i, 6);
      const nTilt = seededNoise(layerIndex + 57, i, 7);
      const nScale = seededNoise(layerIndex + 71, i, 8);
      const nRest = seededNoise(layerIndex + 89, i, 9);

      const spinMs = Math.round(lerp(spec.spinMsMin, spec.spinMsMax, nSpin));
      const durationMs = Math.round(lerp(spec.fallMsMin, spec.fallMsMax, nFall));

      bills.push({
        layer: layerIndex as MoneyLayer,
        // Spread the layer's notes across the band by index, then jitter — a
        // pure hash clumps, and a clump of three is a stripe, not weather.
        xPct: round2(
          lerp(X_MIN_PCT, X_MAX_PCT, (i + 0.5) / spec.count) +
            (nX - 0.5) * ((X_MAX_PCT - X_MIN_PCT) / spec.count) * 0.8,
        ),
        driftVw: round2((nDrift - 0.5) * 2 * DRIFT_VW),
        // Spread the layer evenly around the loop by index, then jitter — a
        // pure hash leaves gaps, and a gap in a fall is a lull.
        phaseMs: Math.round(
          -durationMs * ((i + lerp(0.15, 0.85, nPhase)) / spec.count) * PHASE_SPREAD,
        ),
        durationMs,
        spinMs,
        spinDelayMs: Math.round(-nSpinOff * spinMs),
        tiltDeg: round2((nTilt - 0.5) * 2 * TILT_DEG),
        scale: round2(spec.scale * lerp(1 - SCALE_JITTER, 1 + SCALE_JITTER, nScale)),
        opacity: spec.opacity,
        blurPx: spec.blurPx,
        restVh: round2(lerp(REST_VH_MIN, REST_VH_MAX, nRest)),
      });
    }
  });

  return bills;
}

/** The notes, computed once — the geometry is constant, so re-deriving it per
 *  render would only be a chance for the two to disagree. */
export const MONEY_BILLS: Bill[] = moneyBills();

/** The slowest note's period — one full traverse of the frame. */
export const MONEY_LOOP_MS: number = MONEY_BILLS.reduce(
  (max, bill) => Math.max(max, bill.durationMs),
  0,
);

/**
 * How long the FINISHED question holds while the money keeps falling, before
 * the scene advances.
 *
 * Deliberately a product number rather than something derived from the notes:
 * the fall loops, so there is no "when it finishes" to wait for, and what this
 * actually buys is reading time for the question. It is SHORTER than
 * `MONEY_LOOP_MS`, so the money is still coming down as the scene crossfades
 * into the stats — the screen that answers this one.
 *
 * It is NOT how long the money is visible: the fall starts with the scene
 * (onboarding.tsx), so the notes are on screen for the typing too — ~3.8s
 * against the 2.4s here. Those were the same number only while the fall was
 * gated behind the line landing.
 *
 * Kept tight because onboarding drop-off is watched (see deploy.md on the Type
 * Radar pause for the precedent of a hold being questioned on exactly those
 * grounds).
 */
export const MONEY_VIEW_MS = 2400;
