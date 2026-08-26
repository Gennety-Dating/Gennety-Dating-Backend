/**
 * Which wash classes a relationship-intent tile carries.
 *
 * Pure, and in its own module for the same reason the height drum's decisions
 * are: this is the half of the effect that can be tested away from a DOM, and
 * it is the half that was silently wrong. The class used to be added in the
 * click handler with `classList.add`, but the same tap calls `setPicked`,
 * React re-renders, and its own `className` overwrites anything written by
 * hand — so the spread class was wiped in the tick it was added and the
 * animation never ran once. Deriving it here means React is the only writer.
 *
 * The anchor point (`--sx` / `--sy`) stays imperative on purpose: no `style`
 * prop is passed, so React does not own inline style and that write survives.
 */

/** Whether a tile is mid-wash, and in which direction. */
export type IntentWave = "on" | "off" | undefined;

/**
 * A tile that has never been touched carries neither wash class, so the screen
 * does not play four recede animations on its first paint — including for a
 * selection restored from the server, which nobody tapped. After that the two
 * classes always alternate on a given tile (a tap on a selected tile can only
 * deselect it), which is what restarts the animation without a reflow trick.
 */
export function tileClass(on: boolean, wave: IntentWave): string {
  const spread = wave === "on" ? " is-spreading" : wave === "off" ? " is-receding" : "";
  return `ob-intent${on ? " is-on" : ""}${spread}`;
}
