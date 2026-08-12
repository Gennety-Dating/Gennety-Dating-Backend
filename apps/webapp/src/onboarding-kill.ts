/**
 * The competitor icons being killed off one by one on the stats scene.
 *
 * The scene cycles three metrics — 75 hours, 9 500 swipes, $200 — and until now
 * the icon tray above them was inert scenery: the numbers made the argument and
 * the three apps just sat there watching. Each metric now takes out the icon
 * beneath it. While its number counts up the icon trembles harder and harder
 * and drains into burgundy; the instant the number lands it is fully red and
 * the shake stops dead; then two red strokes draw across it. Three metrics,
 * three apps crossed out, and the screen ends on the picture the copy has been
 * describing.
 *
 * This module owns only the CLOCK. The motion itself is keyframes in
 * onboarding.css — same split as `onboarding-crumble.ts`, so the shake runs on
 * the compositor and the timings stay testable with no DOM.
 *
 * Three constraints decided the numbers below:
 *
 *  - **The ramp ends exactly when the number does.** "Fully red when the digit
 *    is fully printed" is the whole beat, so the count-up duration lives HERE
 *    and `CountUpText` reads it, rather than the 1250 being hardcoded inside
 *    that component with the CSS guessing at it. Two copies of this number
 *    would drift on the first retune and the miss would be invisible in a diff.
 *  - **The whole kill fits inside one metric step.** A strike still drawing
 *    when the next number starts counting reads as two icons dying at once and
 *    breaks the "one at a time" reading. `KILL_TOTAL_MS < STAT_CYCLE_INTERVAL_MS`
 *    is pinned by a test rather than left to whoever next retunes a constant.
 *  - **The drama plays once.** After the first full lap the icons stay crossed
 *    out while the numbers keep cycling (see `iconKillPhase`) — replaying it
 *    would read as the apps coming back to life.
 */

/** Auto-cycle interval of the metric drum. One step = one icon's whole kill. */
export const STAT_CYCLE_INTERVAL_MS = 2500;

/**
 * How long a metric's number counts up — and therefore how long the shake ramp
 * and the reddening run, because they exist to track it. Read by `CountUpText`
 * and published to CSS as `--kill-count`.
 */
export const STAT_COUNT_UP_MS = 1250;

/**
 * The strike starts the moment the number lands, not a beat later: the icon
 * going fully red and the first stroke arriving are one event.
 */
export const KILL_STRIKE_DELAY_MS = STAT_COUNT_UP_MS;

/** Gap between the two strokes, so it reads as drawn rather than stamped. */
export const KILL_STRIKE_STAGGER_MS = 130;

/** How long one stroke takes to sweep corner to corner. */
export const KILL_STRIKE_DRAW_MS = 380;

/** When the second stroke finishes — the end of the whole beat. */
export const KILL_TOTAL_MS =
  KILL_STRIKE_DELAY_MS + KILL_STRIKE_STAGGER_MS + KILL_STRIKE_DRAW_MS;

/**
 * What one icon is doing right now.
 *
 * `killing` runs the animation; `killed` is its final frame held statically, so
 * the class swap at the end of the beat changes nothing on screen.
 */
export type IconKillPhase = "alive" | "killing" | "killed";

/**
 * Resolve one icon's phase from the drum's position.
 *
 * `lapDone` is the scene's existing "you may continue" signal — it flips when
 * the drum wraps back to the first metric, which is exactly the moment every
 * icon has had its turn. From there everything stays `killed`: the numbers keep
 * cycling, but an icon that already died does not die again.
 */
export function iconKillPhase(
  iconIndex: number,
  cycleIndex: number,
  lapDone: boolean,
): IconKillPhase {
  if (lapDone) return "killed";
  if (iconIndex < cycleIndex) return "killed";
  if (iconIndex === cycleIndex) return "killing";
  return "alive";
}

/**
 * The clock handed to CSS, as custom properties.
 *
 * Emitted onto the tray so every tile inherits one set of numbers — a per-tile
 * copy would let two icons disagree about how long a strike takes.
 */
export const KILL_CSS_VARS: Record<string, string> = {
  "--kill-count": `${STAT_COUNT_UP_MS}ms`,
  "--kill-strike-delay": `${KILL_STRIKE_DELAY_MS}ms`,
  "--kill-strike-stagger": `${KILL_STRIKE_STAGGER_MS}ms`,
  "--kill-strike-draw": `${KILL_STRIKE_DRAW_MS}ms`,
};
