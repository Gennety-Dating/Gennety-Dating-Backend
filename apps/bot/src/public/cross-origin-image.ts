import type { Response } from "express";

/**
 * Mark an image response as loadable from another origin.
 *
 * `helmet()` sets `Cross-Origin-Resource-Policy: same-origin` on every public
 * API response, and the Mini Apps live on a DIFFERENT host to the API they read
 * from — `dating-calendar.gennety.com` against `dating-api.gennety.com`, and
 * `demo-app` against `demo-api` (ARCHITECTURE.md → Production Endpoints; the
 * split is forced, because initData is HMAC-signed with a bot token and only the
 * process holding that token can verify it). So every image proxy on this API is
 * cross-origin by construction and needs the header relaxed for its own bytes.
 *
 * **The failure is silent and asymmetric, which is why this lives in one place
 * rather than at each call site.** CORS and CORP are different gates: `fetch()`
 * is governed by CORS, which passes, while an `<img>` is a no-cors subresource
 * governed by CORP, which does not. A route can therefore serve a perfect
 * `200 image/jpeg` to curl, to a server-side probe and to every test in this
 * repo, and still be blocked by the browser — the only symptom is the client's
 * `onerror` fallback (a monogram, a category glyph) appearing as though the
 * photo merely failed to load. The Date Ticket avatars were diagnosed twice on
 * that evidence — once as response size, once as upstream flakiness — before
 * anyone compared the response headers of a working image proxy with a broken
 * one (DECISIONS.md 2026-08-20).
 *
 * Apply it to an image a BROWSER loads cross-origin. Deliberately NOT applied
 * to:
 *   - `/v1/founder/report/:token/media` — the report page is served by this same
 *     host, so its media is same-origin and the default is correct;
 *   - `/v1/referral/card` — fetched by Telegram's servers to render a shared
 *     photo, never by a browser, so CORP is not enforced on it at all;
 *   - `/v1/matches/partner-photo` — consumed by the native iOS client and its
 *     notification extension over URLSession, which is not a browser either.
 *
 * Relaxing a security header where nothing needs it is how the protection stops
 * meaning anything, so the rule is: add a caller here only when a browser on
 * another origin genuinely has to draw the bytes.
 */
export function allowCrossOriginImage(res: Response): void {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
