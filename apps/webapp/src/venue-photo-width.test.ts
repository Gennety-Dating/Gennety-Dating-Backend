import { describe, expect, it } from "vitest";
// `?raw` rather than an import: `venue-change.ts` is a Mini App entry that runs
// on import for its DOM side effects and exports nothing, so its constants are
// only reachable as source text. Same idiom, and same reason, as
// `location-thinking.test.ts`.
import SRC from "./venue-change.ts?raw";
import API from "./api.ts?raw";

/**
 * Two properties of the venue board's photos: one about billing, one about a
 * credential.
 *
 * BILLING. A photo's width is part of its URL, so a width is a cache key on the
 * client AND a separate billed Place Photo request upstream. The gallery and
 * the fullscreen viewer used to ask for 1000 and 1600 — every photo a user
 * enlarged was bought twice, for a screen that cannot resolve the difference.
 * Serving both from one list of links made the viewer free: it paints the
 * bitmaps the gallery already decoded. That saving exists only while the two
 * read the SAME links; a viewer that fetched its own would silently reintroduce
 * the double charge, with nothing visible on screen to reveal it.
 *
 * THE CREDENTIAL (A13-L16). Those links used to be built here, with the Mini
 * App's initData appended as `?tma=` — a two-hour bearer credential in every
 * image URL, and so in proxy logs, the WebView cache and `Referer` headers.
 * The server now signs them (1200 px for the gallery, 240 px for the tile — the
 * two widths `venue-change-photos.ts` allows), and this page only reads them.
 */
describe("venue photo links", () => {
  it("serves the gallery and the fullscreen viewer from ONE list of links", () => {
    const viewer = SRC.slice(SRC.indexOf("function openPhotoViewer("));
    expect(viewer).toContain("galleryUrls(v)");
    // Exactly two sources of a photo URL, the tile and the gallery, both the
    // server's signed fields.
    expect(SRC).toContain("return v.thumbnailUrl ?? null;");
    expect(SRC).toContain("return v.photoUrls ?? [];");
  });

  it("never puts initData into a photo URL", () => {
    expect(SRC).not.toContain("venueChangePhotoUrl");
    expect(API).not.toContain("venueChangePhotoUrl");
    expect(API).not.toMatch(/tma:\s*initData/);
    // The ticket avatars had the same leak as `?a=`.
    expect(API).not.toMatch(/\?a=\$\{/);
  });

  it("has no per-slide upgrade left in the viewer", () => {
    // The upgrade was the mechanism that bought the second copy. Its absence is
    // the saving; a reintroduced `sharpen` would restore the charge.
    expect(SRC).not.toContain("sharpen");
  });
});
