/**
 * The four photographs on the relationship-intent screen (PRODUCT_SPEC §1.3).
 *
 * Prepared OUTSIDE the repo (`~/Desktop/gennety-intent-photos/prepare.mjs`) —
 * the sources are 1.5-2 MB PNGs at 960x1696, and the deploy rsyncs the working
 * tree, so keeping them here would ship them. What lands is 540x720 WebP, about
 * 35 kB each: 165 CSS px wide at DPR 3 is 495, and 540 leaves headroom without
 * doubling the byte cost.
 *
 * They are one SET, not four pictures. Same treatment, same class of beauty,
 * same crop — because a prettier frame on one option ranks the axis, which is
 * the single thing this screen may not do (see `IntentScreen`).
 *
 * Imported rather than globbed, unlike the preference screen: there are exactly
 * four, each belongs to one named option, and a missing file should fail the
 * build rather than silently leave a tile blank.
 */
import spark from "./intent/spark.webp";
import open from "./intent/open.webp";
import falling from "./intent/falling.webp";
import longterm from "./intent/longterm.webp";

export const INTENT_PHOTOS = { spark, open, falling, longterm } as const;
