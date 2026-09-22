import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";
import type { ShowcasePlace } from "../services/curated-venue.js";
import { ALLOWED_PHOTO_WIDTHS } from "./places-photo.js";

/**
 * Signed links to curated-venue photos for the iOS standby canvas, and — at
 * the pin width only — for the thumbnails of a match's frequently visited
 * places (`partnerFrequentPlaces`, founder decision 2026-09-13).
 *
 * Same device as the partner photos (`partner-photos.ts`): an image loader
 * sends no Authorization header, so the link itself carries the permission —
 * an HMAC over the venue, the width and an expiry. Only those two lists mint
 * them, which is what keeps the route from being a free Places photo proxy
 * for anyone who can guess a row id: without a signature it answers nothing,
 * and the signature cannot be moved to another venue or width.
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

/**
 * `index` is the photo's slot: 0 the cover, 1… the venue profile's gallery.
 *
 * The cover keeps the payload it was born with, so links minted before the
 * gallery existed stay valid for the rest of their day. A gallery slot is part
 * of what is signed — otherwise one signed link would open all of a place's
 * photos, and the cap on them (`SHOWCASE_GALLERY_MAX`, ten since 2026-09-22)
 * would be the client's to keep rather than the server's.
 */
export function signVenuePhoto(venueId: string, width: number, expiresAt: number, index = 0): string {
  const subject = index === 0 ? venueId : `${venueId}#${index}`;
  const payload = `venue-photo:${subject}:${width}:${expiresAt}`;
  return createHmac("sha256", env.BOT_TOKEN).update(payload).digest("hex").slice(0, 24);
}

export function venuePhotoSignatureValid(
  venueId: string,
  width: number,
  expiresAt: number,
  given: string,
  now: number = Date.now(),
  index = 0,
): boolean {
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
  const expected = signVenuePhoto(venueId, width, expiresAt, index);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Absolute URL the client can hand straight to an image loader. A gallery slot
 * rides in the PATH (`/photo/2`) for the same reason as the venue id: a cache
 * keyed by host + path would otherwise fold a place's ten photos into one.
 */
export function venuePhotoUrl(
  venueId: string,
  width: number,
  now: number = Date.now(),
  index = 0,
): string {
  const expiresAt = venuePhotoExpiry(now);
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const query = new URLSearchParams({
    w: String(width),
    e: String(expiresAt),
    sig: signVenuePhoto(venueId, width, expiresAt, index),
  });
  const slot = index === 0 ? "" : `/${index}`;
  return `${base}/v1/venues/${venueId}/photo${slot}?${query.toString()}`;
}

/** Card photo and map-pin photo — the two widths `ALLOWED_PHOTO_WIDTHS` allows. */
const CARD_WIDTH = ALLOWED_PHOTO_WIDTHS[1];
const PIN_WIDTH = ALLOWED_PHOTO_WIDTHS[0];

/**
 * One place as it goes over the wire (`ShowcaseVenue`): photo links are signed
 * per response.
 *
 * The whole gallery's links ride in the list. Signing is free; only fetching a
 * photo is billed, and nobody fetches a gallery until they open the profile —
 * so the profile opens without a request of its own. `photoUrls[0]` is
 * byte-for-byte `photoUrl`, so the cover the card already shows is not
 * downloaded (or billed) a second time.
 *
 * The one serializer of a place profile. It lives beside the signer rather than
 * in `routes/venues.ts` because two routes speak it: the city guide's list and,
 * since 2026-09-22, the venue-change board's `profile` on every card and on the
 * pinned `original` — the same object on both, so one client view model reads
 * both.
 */
export function serializeShowcasePlace(place: ShowcasePlace, now: number = Date.now()) {
  const { photoCount, ...rest } = place;
  const photoUrls = Array.from({ length: photoCount }, (_, index) =>
    venuePhotoUrl(place.id, CARD_WIDTH, now, index),
  );
  return {
    ...rest,
    photoUrl: photoUrls[0] ?? null,
    thumbnailUrl: photoCount > 0 ? venuePhotoUrl(place.id, PIN_WIDTH, now) : null,
    photoUrls,
  };
}
