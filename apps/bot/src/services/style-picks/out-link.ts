import { createHmac, timingSafeEqual } from "node:crypto";
import { STYLE_OUT_LINK_TTL_MS } from "@gennety/shared";
import { env } from "../../config.js";
import type { StyleCatalogItem } from "./catalog.js";

/**
 * The outbound link a Vibe Check card opens (decision journal 2026-10-08).
 *
 * iOS hands `outUrl` to the system browser, which sends no bearer header — so,
 * like the partner-photo and venue-photo links, the link carries its own proof:
 * an HMAC over user id + item id + expiry under `BOT_TOKEN` with a purpose
 * label. A valid link logs a `StyleClick`; an invalid or expired one STILL
 * redirects (a shopper is never blocked), it just logs nothing. The link holds
 * the opaque user id (as `partner-photos.ts` does) and nothing else about the
 * person; the shop sees only our UTM tags.
 */

const PURPOSE = "style-out";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Rounded up to a UTC day so a cached set mints identical links all day. */
export function styleOutExpiry(now: number = Date.now()): number {
  return Math.ceil((now + STYLE_OUT_LINK_TTL_MS) / DAY_MS) * DAY_MS;
}

export function signStyleOut(userId: string, itemId: string, expiresAt: number): string {
  return createHmac("sha256", env.BOT_TOKEN)
    .update(`${PURPOSE}:${userId}:${itemId}:${expiresAt}`)
    .digest("hex")
    .slice(0, 32);
}

export function styleOutSignatureValid(
  userId: string,
  itemId: string,
  expiresAt: number,
  given: string,
  now: number = Date.now(),
): boolean {
  if (!userId || !Number.isFinite(expiresAt) || now > expiresAt) return false;
  const expected = signStyleOut(userId, itemId, expiresAt);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * `l` (the language) rides unsigned: it only chooses between two shops for the
 * same product, so a tampered value changes nothing that matters — and it keeps
 * the Ukrainian shop working for a link whose signature has expired.
 */
export function styleOutUrl(
  userId: string,
  itemId: string,
  language: string,
  now: number = Date.now(),
): string {
  const expiresAt = styleOutExpiry(now);
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const query = new URLSearchParams({
    u: userId,
    e: String(expiresAt),
    s: signStyleOut(userId, itemId, expiresAt),
    l: language,
  });
  return `${base}/v1/style/out/${encodeURIComponent(itemId)}?${query.toString()}`;
}

/**
 * The shop URL: the Ukrainian shop for a uk reader when there is one, our UTM
 * tags, then the item's affiliate parameters.
 */
export function shopUrl(item: StyleCatalogItem, language: string | null): string {
  const target = new URL(language === "uk" && item.urlUA ? item.urlUA : item.url);
  target.searchParams.set("utm_source", "gennety");
  target.searchParams.set("utm_medium", "app");
  target.searchParams.set("utm_campaign", "style_picks");
  target.searchParams.set("utm_content", item.category);
  for (const [key, value] of Object.entries(item.affiliateParams ?? {})) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}
