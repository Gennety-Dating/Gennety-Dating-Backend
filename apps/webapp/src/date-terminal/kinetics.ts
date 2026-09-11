/**
 * The terminal's kinetic feedback — one haptic and one ripple per IMPULSE,
 * while the shake detector (`canvas/shake.ts`) goes on deciding what counts as
 * a SHAKE worth posting.
 *
 * An impulse is a RISING EDGE over the threshold. Each swing of the hand pushes
 * the magnitude over the bar once, and a phone sampling at ~60 Hz reports that
 * one swing as several consecutive readings over it; buzzing on every reading
 * would be a continuous vibration, not a response to the hand. Re-arming only
 * after the magnitude falls back well under the bar, and spacing edges by
 * `IMPULSE_MIN_GAP_MS`, makes the buzz land on the rhythm of the swings — two
 * to six per shake.
 */

import { SHAKE_THRESHOLD, shakeMagnitude, type MotionSample } from "../canvas/shake.js";

/** A reading must fall under this share of the threshold before the next edge. */
export const IMPULSE_REARM_RATIO = 0.6;
/** Never two impulses closer than this, whatever the samples say. */
export const IMPULSE_MIN_GAP_MS = 110;

export interface Impulse {
  at: number;
  /** 0.35 at the threshold, 1 at twice it — drives the ripple's size. */
  strength: number;
}

export function createImpulseGate(): {
  feed(sample: MotionSample): Impulse | null;
  reset(): void;
} {
  let armed = true;
  let lastAt = Number.NEGATIVE_INFINITY;

  return {
    feed(sample: MotionSample): Impulse | null {
      const magnitude = shakeMagnitude(sample);
      if (!armed) {
        if (magnitude < SHAKE_THRESHOLD * IMPULSE_REARM_RATIO) armed = true;
        return null;
      }
      if (magnitude < SHAKE_THRESHOLD) return null;
      armed = false;
      if (sample.at - lastAt < IMPULSE_MIN_GAP_MS) return null;
      lastAt = sample.at;
      const over = (magnitude - SHAKE_THRESHOLD) / SHAKE_THRESHOLD;
      return { at: sample.at, strength: Math.min(1, 0.35 + over * 0.65) };
    },
    reset(): void {
      armed = true;
      lastAt = Number.NEGATIVE_INFINITY;
    },
  };
}
