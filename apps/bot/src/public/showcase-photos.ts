import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

/**
 * Signed links to curated-venue photos for the iOS standby canvas.
 *
 * Same device as the partner photos (`partner-photos.ts`): an image loader
 * sends no Authorization header, so the link itself carries the permission —
 * an HMAC over the venue, the width and an expiry. Only the showcase list
 * mints them, which is what keeps the route from being a free Places photo
 * proxy for anyone who can guess a row id: without a signature it answers
 * nothing, and the signature cannot be moved to another venue or width.
 *
 * **Weaker than the partner photos on purpose.** A partner's face is bound to
 * one viewer and lives ten minutes; a café's photo is the same picture for the
 * whole city and nobody's personal data, so the link is bound to no viewer and
 * lives a day. What it still guards is the Places bill.
 *
 * **The venue id is in the PATH, never only in the query.** The iOS
 * `GennetyRemoteImage` keys its cache by host + path and drops the query (so
 * that re-signing does not mean re-downloading). With the id in the query, all
 * twenty-four pins would share one cache entry and show the same photograph.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Expiry rounded UP to a UTC day boundary, at least a day ahead.
 *
 * Rounded so that every list served within one day mints byte-identical links:
 * the client's URL cache is keyed by the full URL, signature included, and a
 * link that changed on every canvas open would miss it every time.
 */
export function venuePhotoExpiry(now: number = Date.now()): number {
  return Math.ceil((now + DAY_MS) / DAY_MS) * DAY_MS;
}

export function signVenuePhoto(venueId: string, width: number, expiresAt: number): string {
  const payload = `venue-photo:${venueId}:${width}:${expiresAt}`;
  return createHmac("sha256", env.BOT_TOKEN).update(payload).digest("hex").slice(0, 24);
}

export function venuePhotoSignatureValid(
  venueId: string,
  width: number,
  expiresAt: number,
  given: string,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
  const expected = signVenuePhoto(venueId, width, expiresAt);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Absolute URL the client can hand straight to an image loader. */
export function venuePhotoUrl(venueId: string, width: number, now: number = Date.now()): string {
  const expiresAt = venuePhotoExpiry(now);
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const query = new URLSearchParams({
    w: String(width),
    e: String(expiresAt),
    sig: signVenuePhoto(venueId, width, expiresAt),
  });
  return `${base}/v1/venues/${venueId}/photo?${query.toString()}`;
}
