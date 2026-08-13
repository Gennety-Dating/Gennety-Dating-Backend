/**
 * The one deterministic hash the seeded onboarding animations draw geometry
 * from (the intro icon crumble, the money fall).
 *
 * Extracted so there is exactly one implementation: the two callers must agree
 * bit for bit or the same seed produces different art in each, and a hash is
 * precisely the kind of six-line helper that gets copied and then quietly
 * drifts.
 *
 * Why any of this is seeded at all — the rule `preference-layout.ts` states for
 * the preference scatter: a pattern re-rolled per render can never be reviewed
 * twice, and no test can pin it.
 */

/**
 * Deterministic [0,1) from three small integers.
 *
 * `Math.imul` rather than `*`: the multipliers overflow 32 bits, and a plain
 * `*` would silently go through float mantissa rounding, so the same inputs
 * could hash differently across engines. imul is exact 32-bit everywhere.
 */
export function seededNoise(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(c + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Linear interpolation, `t` in [0,1]. */
export function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

/** Rounds to 2dp so emitted inline styles stay short and diff cleanly. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
