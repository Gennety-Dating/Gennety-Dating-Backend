/**
 * The photographs on the relationship-intent screen (PRODUCT_SPEC §1.3).
 *
 * Prepared OUTSIDE the repo (`~/Desktop/gennety-intent-photos/prepare.mjs`) —
 * the sources are 1.5-2 MB PNGs at 960x1696, and the deploy rsyncs the working
 * tree, so keeping them here would ship them. What lands is 540x720 WebP at
 * quality 74: 165 CSS px wide at DPR 3 is 495, and 540 leaves headroom without
 * doubling the byte cost.
 *
 * They are one SET, not sixteen pictures. Same treatment, same class of beauty,
 * same crop — because a prettier frame on one option ranks the axis, which is
 * the single thing this screen may not do (see `IntentScreen`).
 *
 * **Only the four resting frames are ever downloaded up front** (92 kB), and
 * that is the whole reason a tile may carry four photographs at all: the twelve
 * cycle frames are mounted by `IntentTile` when its option is SELECTED, so a
 * user pays ~80-120 kB for an option they actually chose and nothing for the
 * three they did not. Importing them all here costs only URLs in the bundle —
 * an `<img>` is what triggers the fetch.
 *
 * Imported rather than globbed, unlike the preference screen: each belongs to a
 * named option at a named position, and a missing file should fail the build
 * rather than silently leave a tile blank.
 */
import { INTENT_FRAMES, rotateToRest } from "./intent-cycle.js";

import spark2 from "./intent/spark-2.webp";
import spark3 from "./intent/spark-3.webp";
import spark4 from "./intent/spark-4.webp";
import spark5 from "./intent/spark-5.webp";
import open2 from "./intent/open-2.webp";
import open3 from "./intent/open-3.webp";
import open4 from "./intent/open-4.webp";
import open5 from "./intent/open-5.webp";
import falling1 from "./intent/falling-1.webp";
import falling2 from "./intent/falling-2.webp";
import falling4 from "./intent/falling-4.webp";
import falling6 from "./intent/falling-6.webp";
import longterm2 from "./intent/longterm-2.webp";
import longterm3 from "./intent/longterm-3.webp";
import longterm4 from "./intent/longterm-4.webp";
import longterm5 from "./intent/longterm-5.webp";

const FILES: Record<string, Record<number, string>> = {
  spark: { 2: spark2, 3: spark3, 4: spark4, 5: spark5 },
  open: { 2: open2, 3: open3, 4: open4, 5: open5 },
  falling: { 1: falling1, 2: falling2, 4: falling4, 6: falling6 },
  longterm: { 2: longterm2, 3: longterm3, 4: longterm4, 5: longterm5 },
};

/**
 * Per option, the frames it plays — already rotated so `cycle[0]` is what the
 * tile shows at rest. `IntentTile` relies on that: an unselected tile renders
 * `cycle[0]` and nothing else, which is what keeps the other twelve off the
 * wire until somebody chooses.
 */
export const INTENT_PHOTOS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(INTENT_FRAMES).map(([id, frames]) => [
    id,
    rotateToRest(frames.order, frames.rest).map((n) => {
      const url = FILES[id]?.[n];
      if (!url) throw new Error(`intent: no photo for ${id} frame ${n}`);
      return url;
    }),
  ]),
);
