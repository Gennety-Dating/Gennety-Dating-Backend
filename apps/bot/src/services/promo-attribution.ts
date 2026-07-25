import { createHash } from "node:crypto";
import { env } from "../config.js";

/**
 * iOS deferred-deep-link attribution store (PROMO_CODES_PRODUCT_SPEC.md).
 *
 * Apple does not pass a parameter through an App Store install, so the promo
 * landing page (`GET /v1/promo/:code`) records a COARSE device fingerprint →
 * promo code just before it bounces the visitor to the App Store, and the app's
 * first launch matches it back via `POST /v1/me/promo/claim-deferred`.
 *
 * This is deliberately best-effort (there is no manual fallback by product
 * decision — see the spec's reliability caveat). The store is in-memory with a
 * short TTL, matching the single-PM2-process `usage-limiter` pattern: a process
 * restart drops pending attributions, which is acceptable for a best-effort
 * signal. The clipboard code is the stronger, independent second signal.
 */

interface Attribution {
  code: string;
  expiresAt: number;
}

const store = new Map<string, Attribution>();

/** Coarse, privacy-light fingerprint: IP + UA family + language, hashed. */
export function fingerprint(parts: {
  ip: string | undefined;
  userAgent: string | undefined;
  acceptLanguage: string | undefined;
}): string {
  const ua = (parts.userAgent ?? "").slice(0, 120);
  const lang = (parts.acceptLanguage ?? "").split(",")[0]?.trim() ?? "";
  const ip = parts.ip ?? "";
  return createHash("sha256").update(`${ip}|${ua}|${lang}`).digest("hex").slice(0, 32);
}

function ttlMs(): number {
  return env.PROMO_ATTRIBUTION_TTL_MIN * 60 * 1000;
}

/** Opportunistic sweep of expired rows (called on every write/read). */
function sweep(now: number): void {
  if (store.size === 0) return;
  for (const [key, row] of store) {
    if (row.expiresAt <= now) store.delete(key);
  }
}

/** Record a landing-page touch: this fingerprint saw this promo code. */
export function recordAttribution(fp: string, code: string): void {
  const now = Date.now();
  sweep(now);
  store.set(fp, { code, expiresAt: now + ttlMs() });
}

/**
 * Match a first-launch fingerprint back to a recently-recorded promo code.
 * One-shot: the entry is consumed on a hit so a shared fingerprint can't leak a
 * code to unrelated devices later.
 */
export function matchAttribution(fp: string): string | null {
  const now = Date.now();
  sweep(now);
  const row = store.get(fp);
  if (!row || row.expiresAt <= now) return null;
  store.delete(fp);
  return row.code;
}

/** Test-only reset. */
export function __resetPromoAttributions(): void {
  store.clear();
}
