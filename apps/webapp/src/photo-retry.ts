/**
 * Loading a venue photo, with one retry — the pure half, testable without a DOM.
 *
 * Why this exists at all: a venue photo is Google's bytes streamed through our
 * own proxy, and the droplet turns out to hit occasional TCP connect timeouts
 * reaching Google's CDN (measured 2026-08-08, in production as well as in the
 * demo). The board opens ~13 tiles at once, so a blip lands on a few of them —
 * and the tile's `onerror` handler used to be terminal: it swapped in the
 * category glyph, marked the tile settled, and never asked again. One dropped
 * connection therefore cost a permanently blank tile for the rest of the
 * session, with closing and reopening the Mini App as the only way back.
 *
 * The server retries its own upstream leg (`routes/venue-change.ts`), which is
 * where the measured failures are. This covers the leg the server cannot see:
 * the phone's own connection to us. Between them, a tile has to fail twice, on
 * two different hops, before the user sees a glyph instead of a photograph.
 *
 * Deliberately ONE retry, not a ladder. A second failure at the same second is
 * far more likely to be "this photo is genuinely unavailable" than a second
 * blip, and a board of 13 tiles retrying three times each turns a bad moment
 * into a burst — which is itself a way to keep the connection saturated.
 */

export interface PhotoLoadDeps {
  /**
   * Start loading `src` and report the outcome exactly once. Deliberately a
   * function rather than an `HTMLImageElement`-shaped object: the retry policy
   * has no business knowing what an image element is, and a test's fake is
   * then two lines instead of a DOM impersonation.
   */
  load: (src: string, done: (ok: boolean) => void) => void;
  /** `setTimeout`, injected so a test doesn't wait out the real pause. */
  schedule: (fn: () => void, ms: number) => void;
}

/**
 * The real loader. Lives here so the adapter and the policy it feeds stay
 * next to each other, but it is the only thing in this module that touches
 * the DOM — nothing at import time, so a node-environment test is fine.
 */
export function domImageLoader(src: string, done: (ok: boolean) => void): void {
  const img = new Image();
  img.decoding = "async";
  img.onload = () => done(true);
  img.onerror = () => done(false);
  img.src = src;
  // Already in the browser cache (re-entering a detail page): report at once
  // so a cached photo never flashes a skeleton.
  if (img.complete && img.naturalWidth > 0) done(true);
}

/**
 * Pause before the retry. Long enough to be on the far side of a momentary
 * blip, short enough that a rescued tile still arrives while the user is
 * looking at the board rather than after they have scrolled past it.
 */
export const PHOTO_RETRY_DELAY_MS = 600;

/**
 * The retry asks for a marked URL rather than the identical one.
 *
 * The proxy reads only `ref`, `w` and `tma`, so an extra parameter changes
 * nothing about what comes back — but it does guarantee a genuinely fresh
 * request instead of whatever the client may have remembered about the URL
 * that just failed. A retry that quietly re-serves the failure would be worse
 * than no retry, because it would look like one had happened.
 */
export function retryUrl(url: string): string {
  return url.includes("?") ? `${url}&retry=1` : `${url}?retry=1`;
}

/**
 * Load `url`, retrying once, and call `settle` exactly once with the verdict.
 *
 * `settle` is handed the URL that actually decoded, NOT the one it was asked
 * for — the two differ whenever the retry is what succeeded. Painting the
 * original URL after a successful retry would issue a second request for the
 * bytes we just proved unreliable, and hand the tile one more chance to fail.
 * `null` means both attempts failed and the caller should fall back.
 */
export function loadPhotoWithRetry(
  url: string,
  settle: (loaded: string | null) => void,
  deps: PhotoLoadDeps,
): void {
  let settled = false;
  const finish = (loaded: string | null): void => {
    if (settled) return;
    settled = true;
    settle(loaded);
  };

  const attempt = (src: string, isRetry: boolean): void => {
    // Per-attempt guard as well as the global one: a loader that reports from
    // the cache fast path AND later fires an event would otherwise be able to
    // schedule a retry for a load that already succeeded.
    let reported = false;
    deps.load(src, (ok) => {
      if (reported) return;
      reported = true;
      if (ok) {
        finish(src);
      } else if (isRetry) {
        finish(null);
      } else {
        deps.schedule(() => attempt(retryUrl(url), true), PHOTO_RETRY_DELAY_MS);
      }
    });
  };

  attempt(url, false);
}
