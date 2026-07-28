/**
 * Counter engine for the final beat of the Type Radar "thinking" sequence
 * (`TYPE_RADAR_PRODUCT_SPEC.md`): the "Scanning profiles {n}" line whose number
 * climbs on a non-linear deceleration curve — quick small ticks at first,
 * then bigger jumps arriving further apart, so it reads as a search narrowing
 * down rather than a progress bar filling.
 *
 * This module is **pure**: it emits the whole frame list up front, so the beat
 * needs no execution engine of its own. Each frame becomes one ordinary
 * {@link file://./ai-stream.ts StatusStep}, and the existing `runStatusSequence`
 * plays them exactly like the scripted beats — inheriting its rich-shimmer path,
 * its classic edit fallback, its injectable `wait`, and its error tolerance.
 */

/** One rendered frame of the counter: the number shown, and for how long. */
export interface ScanFrame {
  /** Profile count displayed on this frame. */
  n: number;
  /** How long this number stays on screen before the next tick (ms). */
  holdMs: number;
}

/** Inclusive bounds of the number the counter settles on. */
export const TARGET_MIN = 160;
export const TARGET_MAX = 220;

/** Inclusive bounds of the number the counter starts from. */
export const START_MIN = 3;
export const START_MAX = 6;

/**
 * How long the final number is held before the sequence is torn down. This
 * REPLACES the last tick's phase delay rather than being added on top of it, so
 * the beat totals ~3.9s and the whole sequence lands on its ~10.1s budget.
 */
export const FINAL_HOLD_MS = 500;

/**
 * Progress thresholds (as a fraction of `targetN`) at which the curve moves to
 * the next, slower phase.
 */
const PHASE_2_AT = 0.3;
const PHASE_3_AT = 0.7;

interface Phase {
  /** Inclusive increment range applied on a tick in this phase. */
  step: readonly [number, number];
  /** Inclusive delay range this phase's frame is held for (ms). */
  delay: readonly [number, number];
}

/** Fast small ticks → slower bigger jumps. Index is the phase, 0-based. */
const PHASES: readonly [Phase, Phase, Phase] = [
  { step: [6, 10], delay: [120, 180] },
  { step: [11, 19], delay: [280, 380] },
  { step: [20, 33], delay: [450, 600] },
];

/**
 * Hard ceiling on emitted frames. Termination is already guaranteed (every tick
 * advances by at least 6, from ≤6 toward ≤220, so ≤37 ticks), but each frame is
 * one Bot API call and this bounds the burst regardless of what the RNG does.
 */
export const MAX_FRAMES = 40;

/** Random integer in `[min, max]`, inclusive on both ends. */
function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** The phase governing a tick taken at `current` out of `target`. */
function phaseFor(current: number, target: number): Phase {
  const progress = current / target;
  if (progress < PHASE_2_AT) return PHASES[0];
  if (progress < PHASE_3_AT) return PHASES[1];
  return PHASES[2];
}

/**
 * Build the full frame list for the counter beat.
 *
 * The first frame is the starting number (3–6), each subsequent frame advances
 * by that phase's increment, and the last frame is clamped to land on exactly
 * `targetN` — a counter that overshoots its own total reads as broken. That
 * final frame is held for {@link FINAL_HOLD_MS} instead of its phase delay.
 *
 * Measured over 5000 seeds: **~15.7 frames, mean 4534ms** (p5 3852, p95 5335;
 * observed 3458–5885). That is a little above the spec's "~3900ms" headline —
 * the two are in tension, and the step/delay ranges are the concrete
 * algorithmic contract, so they are implemented verbatim rather than tuned down
 * to hit the round number. With the 6200ms of scripted beats the whole sequence
 * averages ~10.7s against a stated "~10.1s"; the stated figure sits near this
 * distribution's 5th percentile. Shrink `TARGET_MAX` or the phase delays if the
 * headline number is the thing that matters.
 *
 * @param rng injectable `[0,1)` source — tests pass a seeded generator so the
 *            curve is deterministic; production uses `Math.random`.
 */
export function buildScanFrames(rng: () => number = Math.random): ScanFrame[] {
  const target = randInt(rng, TARGET_MIN, TARGET_MAX);
  let current = randInt(rng, START_MIN, START_MAX);

  const frames: ScanFrame[] = [];
  while (frames.length < MAX_FRAMES) {
    const phase = phaseFor(current, target);
    // The frame currently being emitted is held for its own phase's delay; the
    // phase is read at the number being *shown*, so the pace visibly decays
    // alongside the jumps rather than a step behind them.
    frames.push({ n: current, holdMs: randInt(rng, phase.delay[0], phase.delay[1]) });

    if (current >= target) break;
    const next = current + randInt(rng, phase.step[0], phase.step[1]);
    current = Math.min(next, target);
  }

  // Guaranteed non-empty: the loop always pushes before it can break.
  const last = frames[frames.length - 1]!;
  // MAX_FRAMES is a safety valve, not an expected exit — if it ever trips, the
  // counter must still settle on the total it promised rather than stop midway.
  last.n = target;
  last.holdMs = FINAL_HOLD_MS;

  return frames;
}

/** Total wall-clock duration of a frame list, in ms. */
export function scanFramesDurationMs(frames: readonly ScanFrame[]): number {
  return frames.reduce((sum, frame) => sum + frame.holdMs, 0);
}
