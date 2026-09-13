import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config.js";

/**
 * Signed links to the Date Ticket Mini App's two avatars (A13-L16).
 *
 * `GET /v1/matches/:id/ticket/photo/:side` streams the caller's or the
 * partner's first profile photo. An `<img>` sends no Authorization header, so
 * the Mini App used to append its initData as `?a=` — a two-hour bearer
 * credential that then sat in proxy access logs, the WebView's cache and
 * history, and `Referer` headers. The state response, which IS fetched with
 * the header, now hands out these links instead: an HMAC over the viewer, the
 * match, the side and an expiry — the device `partner-photos.ts` already uses
 * for the native pitch, with the Telegram id as the viewer because that is
 * the one identifier the gate handlers speak.
 *
 * **The signature is not the whole gate.** The route still resolves the photo
 * through `getTicketPhoto`, which re-checks that the viewer is a participant,
 * so a link minted before a match ended stops showing a face with it.
 *
 * **Why the expiry is rounded.** The gate polls its state every four seconds
 * on the screens that show these avatars. A link that changed on every poll
 * would change the `<img>` src and re-download the photo each time, so the
 * expiry is rounded up to a ten-minute boundary: every poll inside one window
 * mints the same link, and a link always has at least ten minutes to live.
 * Ten minutes, not the venue photos' day: this is a person's face.
 */

export type TicketPhotoSide = "self" | "partner";

export const TICKET_PHOTO_TTL_MS = 10 * 60 * 1000;

/** At least `TICKET_PHOTO_TTL_MS` ahead, rounded up to a TTL boundary. */
export function ticketPhotoExpiry(now: number = Date.now()): number {
  return Math.ceil((now + TICKET_PHOTO_TTL_MS) / TICKET_PHOTO_TTL_MS) * TICKET_PHOTO_TTL_MS;
}

function signature(
  telegramId: string,
  matchId: string,
  side: TicketPhotoSide,
  expiresAt: number,
): string {
  const payload = `ticket-photo:${matchId}:${telegramId}:${side}:${expiresAt}`;
  return createHmac("sha256", env.BOT_TOKEN).update(payload).digest("hex").slice(0, 24);
}

export function ticketPhotoSignatureValid(
  telegramId: string,
  matchId: string,
  side: TicketPhotoSide,
  expiresAt: number,
  given: string,
  now: number = Date.now(),
): boolean {
  if (!/^-?\d{1,20}$/.test(telegramId)) return false;
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
  const expected = signature(telegramId, matchId, side, expiresAt);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Absolute URL an `<img>` can take as-is. */
export function ticketPhotoUrl(
  telegramId: number | bigint,
  matchId: string,
  side: TicketPhotoSide,
  now: number = Date.now(),
): string {
  const viewer = String(telegramId);
  const expiresAt = ticketPhotoExpiry(now);
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const query = new URLSearchParams({
    v: viewer,
    e: String(expiresAt),
    sig: signature(viewer, matchId, side, expiresAt),
  });
  return `${base}/v1/matches/${matchId}/ticket/photo/${side}?${query.toString()}`;
}
