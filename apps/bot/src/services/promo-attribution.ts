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

/**
 * Hard ceiling on live entries. `GET /v1/promo/:code` is public and pre-auth,
 * and the fingerprint includes the fully attacker-controlled `User-Agent`, so
 * distinct entries are free to manufacture. A Map with no ceiling grows for the
 * whole TTL; combined with the old sweep-on-every-access (below) that was
 * quadratic work on a public endpoint. Insertion order makes the oldest key the
 * first one `keys()` yields, so eviction is O(1).
 */
const MAX_ENTRIES = 10_000;

/** How often the background sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

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

/** Drop every expired row. Called on a timer, never per request. */
function sweep(now: number): void {
  if (store.size === 0) return;
  for (const [key, row] of store) {
    if (row.expiresAt <= now) store.delete(key);
  }
}

/**
 * Background sweeper. `.unref()` so an idle timer never keeps the process
 * alive — this store is best-effort and must not influence shutdown.
 */
const sweepTimer = setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS);
sweepTimer.unref?.();

/** Record a landing-page touch: this fingerprint saw this promo code. */
export function recordAttribution(fp: string, code: string): void {
  const now = Date.now();
  // Bound the map without scanning it: evict the oldest key(s) when full.
  // Re-setting an existing key does not grow the map, so only genuinely new
  // fingerprints can trip this.
  while (!store.has(fp) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  store.set(fp, { code, expiresAt: now + ttlMs() });
}

/**
 * Match a first-launch fingerprint back to a recently-recorded promo code.
 * One-shot: the entry is consumed on a hit so a shared fingerprint can't leak a
 * code to unrelated devices later.
 */
export function matchAttribution(fp: string): string | null {
  const now = Date.now();
  const row = store.get(fp);
  // Expiry is enforced per-lookup rather than by the sweep, so a stale row that
  // the timer has not reached yet can never be handed out.
  if (!row || row.expiresAt <= now) {
    if (row) store.delete(fp);
    return null;
  }
  store.delete(fp);
  return row.code;
}

/** Test-only reset. */
export function __resetPromoAttributions(): void {
  store.clear();
}
