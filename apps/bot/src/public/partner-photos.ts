import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@gennety/db";
import { ACTIVE_MATCH_STATUSES } from "../services/active-match-priority.js";
import { env } from "../config.js";

/**
 * Partner photos for the native cinematic pitch (iOS PRODUCT_SPEC → «Кино-питч»).
 *
 * Telegram delivers the partner's photos as a `protect_content` media group.
 * The native client has no equivalent transport, so it needs URLs — and this
 * module is the only place that decides who may load them.
 *
 * **The entitlement is the product rule, not a new one.** PRODUCT_SPEC has
 * always said the partner's face is visible to the match partner and to nobody
 * else; this implements exactly that on the second surface: the viewer must be
 * a participant, and the match must still be live. A `cancelled`/`expired` row
 * stops serving immediately — after a decline the pair is banned for life
 * (§3.2 filter 6), so there is no reason left to hand out the face.
 *
 * **Bytes go through us rather than through a Supabase signed URL**, even for
 * photos that have one. Half the photo set is Telegram `file_id`s (bot-side
 * uploads), which have no signed-URL form at all, so a mixed design would mean
 * two URL kinds, two failure modes and a client that branches on them. One
 * proxy keeps the entitlement check in one place. The cost is our own
 * bandwidth for a handful of images per match, which is the same trade the
 * venue-photo and admin-media proxies already make.
 */

const PHOTO_URL_TTL_MS = 10 * 60 * 1000;

/**
 * Lifetime for the copy that travels inside the drop push (§5.3).
 *
 * Ten minutes is right for a screen the user is looking at and wrong for a
 * notification: APNs stores an undelivered alert and hands it over when the
 * phone comes back online, which is exactly the case the push exists for. A
 * link that expired while the phone was off would drop the picture in the one
 * scenario that matters.
 *
 * A day is not a weaker guarantee than ten minutes, because the signature was
 * never the whole gate: the bytes route re-resolves entitlement per request,
 * and the match itself dies at the 24h decision deadline — so the URL stops
 * working with the match rather than outliving it either way.
 */
export const PUSH_PHOTO_URL_TTL_MS = 24 * 60 * 60 * 1000;

/** How many photos this viewer may see, or null when not entitled. */
export async function countPartnerPhotos(
  viewerId: string,
  matchId: string,
): Promise<number | null> {
  const resolved = await resolvePartnerPhotos(viewerId, matchId);
  return resolved?.length ?? null;
}

/** The storage ref (Supabase path or Telegram file_id) at `index`, or null. */
export async function partnerPhotoRef(
  viewerId: string,
  matchId: string,
  index: number,
): Promise<string | null> {
  const photos = await resolvePartnerPhotos(viewerId, matchId);
  if (!photos) return null;
  return photos[index] ?? null;
}

async function resolvePartnerPhotos(
  viewerId: string,
  matchId: string,
): Promise<string[] | null> {
  const match = await prisma.match.findFirst({
    where: {
      id: matchId,
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [{ userAId: viewerId }, { userBId: viewerId }],
    },
    select: {
      userAId: true,
      userA: { select: { profile: { select: { photos: true } } } },
      userB: { select: { profile: { select: { photos: true } } } },
    },
  });
  if (!match) return null;
  const partner = match.userAId === viewerId ? match.userB : match.userA;
  return partner.profile?.photos ?? [];
}

/**
 * Short HMAC binding a photo URL to one viewer, one match, one index and an
 * expiry. `AsyncImage` cannot send an Authorization header, which is why the
 * bytes route is reachable without a JWT — the signature is what stands in for
 * one, exactly like the referral card and the founder report's media proxy.
 * The bytes route still re-checks entitlement, so a signed URL minted a minute
 * before a cancellation stops working with it rather than outliving it.
 */
export function signPartnerPhoto(
  viewerId: string,
  matchId: string,
  index: number,
  expiresAt: number,
): string {
  const payload = `partner-photo:${matchId}:${viewerId}:${index}:${expiresAt}`;
  return createHmac("sha256", env.BOT_TOKEN).update(payload).digest("hex").slice(0, 24);
}

export function partnerPhotoSignatureValid(
  viewerId: string,
  matchId: string,
  index: number,
  expiresAt: number,
  given: string,
): boolean {
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = signPartnerPhoto(viewerId, matchId, index, expiresAt);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Absolute URLs the client can hand straight to an image loader. */
export function partnerPhotoUrls(
  viewerId: string,
  matchId: string,
  count: number,
  ttlMs: number = PHOTO_URL_TTL_MS,
): string[] {
  const expiresAt = Date.now() + ttlMs;
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return Array.from({ length: count }, (_, index) => {
    const sig = signPartnerPhoto(viewerId, matchId, index, expiresAt);
    const query = new URLSearchParams({
      m: matchId,
      v: viewerId,
      i: String(index),
      e: String(expiresAt),
      sig,
    });
    return `${base}/v1/match-media/partner-photo?${query.toString()}`;
  });
}
