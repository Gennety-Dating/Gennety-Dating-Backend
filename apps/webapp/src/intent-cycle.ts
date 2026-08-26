/**
 * Which photograph each relationship-intent tile shows, and in what order it
 * cycles once the option is selected (PRODUCT_SPEC §1.3).
 *
 * Frames are numbered by their POSITION in the founder's source folder, which
 * is the numbering on the contact sheet he picks from — so "spark 3" in a
 * message, `spark-3.webp` on disk and `3` here are the same picture.
 *
 * Pure and asset-free on purpose: `intent-photos.ts` resolves these numbers to
 * bundled URLs, and a test that imported that module would be importing sixteen
 * WebPs to check an array rotation.
 */

/** One option's frames: the one shown at rest, plus the founder's cycle order. */
export type IntentFrames = { readonly rest: number; readonly order: readonly number[] };

export const INTENT_FRAMES: Record<string, IntentFrames> = {
  spark: { rest: 2, order: [2, 3, 4, 5] },
  open: { rest: 5, order: [3, 2, 5, 4] },
  falling: { rest: 4, order: [4, 6, 2, 1] },
  longterm: { rest: 4, order: [4, 3, 2, 5] },
};

/** How long each photograph holds before the tile advances to the next one. */
export const INTENT_CYCLE_MS = 2000;

/**
 * The founder's order, rotated to begin on the frame the tile is already
 * showing.
 *
 * It is a CYCLE, so rotating it changes the phase and not the order — `3 2 5 4`
 * started at 5 is `5 4 3 2`, the same loop one step along. What it buys is that
 * the first advance lands two seconds AFTER the tap rather than in the same
 * instant: the tap already plays the shrink into the selected frame, and a
 * photograph swapping under that animation reads as a glitch rather than as the
 * cycle starting. Three of the four options happen to name their resting frame
 * first, so this only actually moves `open` — but leaving it unrotated would
 * make that one option behave differently for no reason a user could see.
 */
export function rotateToRest(order: readonly number[], rest: number): number[] {
  const at = order.indexOf(rest);
  if (at < 0) throw new Error(`frame ${rest} is not in the cycle [${order.join(", ")}]`);
  return [...order.slice(at), ...order.slice(0, at)];
}
