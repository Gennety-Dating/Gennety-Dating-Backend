import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config.js";
import { ALLOWED_PHOTO_WIDTHS } from "./places-photo.js";
import { venuePhotoExpiry } from "./showcase-photos.js";

/**
 * Signed links to venue-change board photos, for the native client.
 *
 * The Mini App pulls board imagery through `/v1/venue-change/photo?tma=…`: an
 * `<img>` sends no Authorization header, so its initData rides the query
 * string. The native client has no initData to put there, and the same rule
 * about headers applies to it — so it gets what the standby canvas already
 * gets, a link that carries the permission itself (`showcase-photos.ts` states
 * the reasoning; this is that device with a different subject).
 *
 * **Why a separate signer instead of reusing `signVenuePhoto`.** That one signs
 * a catalog ROW id and resolves the photograph server-side from it. A board
 * card is not always a catalog row: the Places fallback contributes venues with
 * no curated row at all, and what identifies their picture is the Places photo
 * resource name. So the subject here is the resource name, and the signature is
 * what stops the route from being an open Places proxy for anyone who can name
 * one — exactly the property the `tma` check gives the Mini App path.
 *
 * **The ref travels in the PATH, base64url-encoded.** `GennetyRemoteImage` on
 * iOS keys its cache by host + path and drops the query, so that re-signing a
 * link does not mean re-downloading the image. With the ref in the query every
 * card on the board would collapse onto one cache entry and show one
 * photograph — the bug `showcase-photos.ts` records having already fixed once.
 * A resource name (`places/X/photos/Y`) contains slashes, hence the encoding:
 * one opaque path segment, and no ambiguity about where the ref ends.
 */

/** `places/X/photos/Y` → one opaque, slash-free path segment. */
export function encodePhotoRef(ref: string): string {
  return Buffer.from(ref, "utf8").toString("base64url");
}

/**
 * Back to a resource name. Returns null for anything that is not valid
 * base64url of a plausible ref — the route must not hand junk to Google.
 */
export function decodePhotoRef(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,700}$/.test(token)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  // Re-encoding must reproduce the token exactly: base64url decoding is
  // forgiving, and two spellings of one ref would be two cache entries.
  if (encodePhotoRef(decoded) !== token) return null;
  return decoded;
}

function signature(token: string, width: number, expiresAt: number): string {
  const payload = `venue-change-photo:${token}:${width}:${expiresAt}`;
  return createHmac("sha256", env.BOT_TOKEN).update(payload).digest("hex").slice(0, 24);
}

export function boardPhotoSignatureValid(
  token: string,
  width: number,
  expiresAt: number,
  given: string,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
  const expected = signature(token, width, expiresAt);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Absolute URL an image loader can take as-is.
 *
 * The expiry is the shared day-rounded one, so every board poll within a UTC
 * day mints byte-identical links — the board is polled every ~4 s, and a URL
 * that changed on each poll would miss the client's cache every time and
 * re-download the whole board.
 */
export function boardPhotoUrl(ref: string, width: number, now: number = Date.now()): string {
  const token = encodePhotoRef(ref);
  const expiresAt = venuePhotoExpiry(now);
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const query = new URLSearchParams({
    w: String(width),
    e: String(expiresAt),
    sig: signature(token, width, expiresAt),
  });
  return `${base}/v1/venue-change/photo/${token}?${query.toString()}`;
}

/** Card photo and map-pin photo — the two widths `ALLOWED_PHOTO_WIDTHS` allows. */
export const BOARD_CARD_WIDTH = ALLOWED_PHOTO_WIDTHS[1];
export const BOARD_PIN_WIDTH = ALLOWED_PHOTO_WIDTHS[0];

/** Both links for one venue, or nulls when it has no photograph at all. */
export function boardPhotoLinks(
  ref: string | null,
  now: number = Date.now(),
): { photoUrl: string | null; thumbnailUrl: string | null } {
  if (!ref) return { photoUrl: null, thumbnailUrl: null };
  return {
    photoUrl: boardPhotoUrl(ref, BOARD_CARD_WIDTH, now),
    thumbnailUrl: boardPhotoUrl(ref, BOARD_PIN_WIDTH, now),
  };
}
