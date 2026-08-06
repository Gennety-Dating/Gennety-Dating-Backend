/**
 * The height drum's two pure decisions: which value is under the capsule at a
 * given scroll offset, and whether that crossing has earned a haptic tick.
 *
 * They live outside `onboarding-basics.tsx` because that module reads
 * `window.Telegram` at import time, so it cannot be pulled into a node-env
 * test at all. Same split as `preference-layout.ts` / `market-gate.ts`.
 */

/**
 * Height of one drum row, in px. Must match `.ob-wheel-item` (and the capsule,
 * and twice the pad's complement) in onboarding.css.
 *
 * It is also the drum's *gearing*, and the only honest one: a native scroll
 * moves 1:1 with the finger, so this number alone decides how many values a
 * swipe crosses. It shipped at 56px, which made a deliberate 175 → 190 a long
 * drag; at 38 the same gesture travels ~47% further and a flick genuinely
 * spins. That is close to the floor rather than a midpoint — 38px is about
 * where a native iOS picker row sits, and the 28px numerals leave only a few
 * px of air, so going lower starts costing the thing the screen exists for:
 * being able to stop ON a value and read it.
 */
export const WHEEL_ITEM_H = 38;

/**
 * Ticks closer together than this are indistinguishable from one continuous
 * buzz, so a violent fling is thinned rather than firing ~80 bridge calls in a
 * second. A deliberate scroll crosses a handful of rows per second and never
 * comes near the floor.
 */
export const HAPTIC_MIN_GAP_MS = 30;

/** The value centred under the capsule at this scroll offset. */
export function wheelValueAt(scrollTop: number, min: number, max: number): number {
  const index = Math.round(scrollTop / WHEEL_ITEM_H);
  return Math.min(max, Math.max(min, min + index));
}

/**
 * Whether crossing into `next` should pulse now.
 *
 * A suppressed pulse must NOT be recorded as ticked by the caller: the row was
 * still crossed, and the next scroll frame past the floor should fire for
 * whatever is centred by then rather than swallowing the change.
 */
export function shouldTickHaptic(
  ticked: number,
  next: number,
  tickedAt: number,
  now: number,
): boolean {
  if (next === ticked) return false;
  return now - tickedAt >= HAPTIC_MIN_GAP_MS;
}
