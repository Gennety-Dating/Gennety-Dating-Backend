import { describe, expect, it } from "vitest";
// `?raw` rather than an import: `venue-change.ts` is a Mini App entry that runs
// on import for its DOM side effects and exports nothing, so its constants are
// only reachable as source text. Same idiom, and same reason, as
// `location-thinking.test.ts`.
import SRC from "./venue-change.ts?raw";

/**
 * One property, and it is a billing one rather than a visual one.
 *
 * The photo proxy takes the width in the URL (`?w=`), so a width is a cache key
 * on the client AND a separate billed Place Photo request upstream. The gallery
 * and the fullscreen viewer used to ask for 1000 and 1600 — meaning every photo
 * a user enlarged was bought twice, for a screen that cannot resolve the
 * difference (a 390pt phone at DPR 3 is 1170 physical pixels).
 *
 * Serving both from one width made the viewer free: it paints the bitmap the
 * gallery already decoded. That saving exists only while the two agree, and
 * they agree by sharing a constant — a second `photoUrl(ref, <number>)` for the
 * same photograph silently reintroduces the double charge, with nothing visible
 * on screen to reveal it.
 *
 * The 240px thumbnail is deliberately NOT part of this: a card tile is a
 * genuinely different image at a genuinely different size, and there are 21 of
 * them on a board against the handful a user opens.
 */
describe("venue photo widths", () => {
  it("serves the gallery and the fullscreen viewer from ONE width", () => {
    // Every explicit width handed to the proxy, thumbnail included.
    const widths = [...SRC.matchAll(/photoUrl\([^,)]+,\s*([A-Z_0-9]+)\)/g)].map(
      (m) => m[1],
    );

    // Exactly two: the 240 thumbnail, and the shared gallery/viewer width.
    expect(new Set(widths)).toEqual(new Set(["240", "VENUE_PHOTO_WIDTH"]));
  });

  it("keeps that width inside the proxy's own ceiling", () => {
    // `clampWidth` (apps/bot/src/public/routes/venue-change.ts) caps at 1600 and
    // silently clamps past it — so an over-large value here would not fail, it
    // would just make the constant a lie about what is fetched.
    const m = SRC.match(/const VENUE_PHOTO_WIDTH = (\d+);/);
    expect(m).not.toBeNull();
    const width = Number(m![1]);
    expect(width).toBeLessThanOrEqual(1600);
    // And large enough to still be a fullscreen photo on a modern phone
    // (390pt × DPR 3 = 1170), which is the whole reason it is not the old 1000.
    expect(width).toBeGreaterThanOrEqual(1170);
  });

  it("has no per-slide upgrade left in the viewer", () => {
    // The upgrade was the mechanism that bought the second copy. Its absence is
    // the saving; a reintroduced `sharpen` would restore the charge.
    expect(SRC).not.toContain("sharpen");
  });
});
