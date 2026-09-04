import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { env } from "../config.js";

/**
 * App Store Server API client (IOS_APP_ROADMAP task 0.10) — the trust
 * boundary for StoreKit 2 purchases, mirroring how the Persona webhook works:
 * the client's JWS (or a Server Notification) is only a UNTRUSTED pointer to
 * a transactionId; the authoritative state is always re-fetched from Apple
 * over TLS (`GET /inApps/v1/transactions/{id}`). No local x5c chain
 * verification is needed under this model, so there are no new dependencies
 * (ES256 provider JWT via the existing `jsonwebtoken`, same pattern as APNs).
 */

/** Apple caps App Store Server API tokens at 60 minutes. */
const APPSTORE_JWT_TTL_MS = 50 * 60_000;
const APPSTORE_TIMEOUT_MS = 10_000;

export function appStoreConfigured(): boolean {
  return Boolean(
    env.APPSTORE_KEY_PATH &&
      env.APPSTORE_KEY_ID &&
      env.APPSTORE_ISSUER_ID &&
      env.APPSTORE_BUNDLE_ID,
  );
}

const APPSTORE_PRODUCTION_HOST = "https://api.storekit.itunes.apple.com";
const APPSTORE_SANDBOX_HOST = "https://api.storekit-sandbox.itunes.apple.com";

export function appStoreHost(): string {
  return env.APPSTORE_ENVIRONMENT === "production"
    ? APPSTORE_PRODUCTION_HOST
    : APPSTORE_SANDBOX_HOST;
}

/**
 * Both hosts, configured one first.
 *
 * Apple keeps production and sandbox transactions in SEPARATE stores, and a
 * transaction only exists in the one that minted it — the other answers 404.
 * `APPSTORE_ENVIRONMENT` therefore cannot be a single correct answer: a
 * published app and its TestFlight/sandbox builds report to the same server at
 * the same time, so whichever host we pinned, the other cohort's purchases
 * would 404 → `unknown_transaction` → 422, and a 422 is precisely the answer
 * the client never retries past. Apple's own guidance for the older
 * verifyReceipt rail is the same shape (try production, fall back to sandbox
 * on 21007); this is that rule for the Server API.
 *
 * Order still comes from the env so the common case costs one request: the
 * cohort we expect most traffic from is asked first.
 */
function appStoreHosts(): [string, string] {
  return env.APPSTORE_ENVIRONMENT === "production"
    ? [APPSTORE_PRODUCTION_HOST, APPSTORE_SANDBOX_HOST]
    : [APPSTORE_SANDBOX_HOST, APPSTORE_PRODUCTION_HOST];
}

let cachedKey: string | null = null;
let cachedJwt: { token: string; mintedAt: number } | null = null;

function providerKey(): string {
  cachedKey ??= readFileSync(env.APPSTORE_KEY_PATH, "utf8");
  return cachedKey;
}

/** Mint (or reuse) the ES256 App Store Server API token. */
export function appStoreProviderJwt(now = Date.now()): string {
  if (cachedJwt && now - cachedJwt.mintedAt < APPSTORE_JWT_TTL_MS) return cachedJwt.token;
  const token = jwt.sign({ bid: env.APPSTORE_BUNDLE_ID }, providerKey(), {
    algorithm: "ES256",
    issuer: env.APPSTORE_ISSUER_ID,
    audience: "appstoreconnect-v1",
    expiresIn: "55m",
    keyid: env.APPSTORE_KEY_ID,
  });
  cachedJwt = { token, mintedAt: now };
  return token;
}

/** Test hook — drops the memoized key/JWT so env changes take effect. */
export function resetAppStoreCachesForTest(): void {
  cachedKey = null;
  cachedJwt = null;
}

/**
 * Decode a JWS payload WITHOUT verifying the signature. Only ever used to
 * extract a transactionId to look up authoritatively — never as a source of
 * truth (see module doc).
 */
export function decodeJwsPayload(jws: string): Record<string, unknown> | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The slice of Apple's JWSTransactionDecodedPayload the ticket flow reads. */
export interface AppStoreTransaction {
  transactionId: string;
  originalTransactionId: string | null;
  bundleId: string | null;
  productId: string | null;
  quantity: number;
  /** Present ⇔ Apple refunded/revoked the purchase. */
  revocationDate: number | null;
  /** Auto-renewable subscription paid-through instant (ms epoch); null for
   * consumables. Used as the Premium `periodEnd`. */
  expiresDate: number | null;
  /**
   * What Apple actually charged, in cents of {@link currency}. Apple reports
   * `price` in MILLIUNITS (9990 = $9.99) and only on reasonably recent
   * App Store Server API versions, so both fields are optional and parsed
   * defensively — an older payload simply yields `null` and the purchase is
   * still recorded, just without a money figure.
   */
  priceCents: number | null;
  /** ISO currency of {@link priceCents} (`USD`, `EUR`, …). */
  currency: string | null;
}

export type TransactionLookup =
  | { status: "ok"; transaction: AppStoreTransaction }
  | { status: "not_found" }
  | { status: "unavailable" };

function toTransaction(payload: Record<string, unknown>): AppStoreTransaction | null {
  const transactionId = payload.transactionId;
  if (typeof transactionId !== "string" || !transactionId) return null;
  return {
    transactionId,
    originalTransactionId:
      typeof payload.originalTransactionId === "string" ? payload.originalTransactionId : null,
    bundleId: typeof payload.bundleId === "string" ? payload.bundleId : null,
    productId: typeof payload.productId === "string" ? payload.productId : null,
    quantity: typeof payload.quantity === "number" && payload.quantity > 0 ? payload.quantity : 1,
    revocationDate: typeof payload.revocationDate === "number" ? payload.revocationDate : null,
    expiresDate: typeof payload.expiresDate === "number" ? payload.expiresDate : null,
    // Apple reports `price` in milliunits of the currency (9990 = $9.99), so
    // cents = price / 10.
    priceCents:
      typeof payload.price === "number" && payload.price > 0
        ? Math.round(payload.price / 10)
        : null,
    currency: typeof payload.currency === "string" ? payload.currency : null,
  };
}

/**
 * Whether a StoreKit product id is the Gennety Premium subscription. Matches the
 * full id or its last dot-segment (mirrors `ticketCountForProduct`), so
 * `com.gennety.ios.premium_monthly` and a bare `premium_monthly` both resolve.
 */
export function isPremiumProduct(productId: string | null): boolean {
  if (!productId) return false;
  const target = env.PREMIUM_APPSTORE_PRODUCT_ID;
  return productId === target || (productId.split(".").pop() ?? productId) === target;
}

/**
 * Authoritative transaction lookup. `not_found` covers unknown/forged ids
 * (Apple answers 404/4xx); `unavailable` covers network/5xx — callers must
 * retry later rather than reject the purchase.
 */
export async function getVerifiedTransaction(
  transactionId: string,
): Promise<TransactionLookup> {
  if (!appStoreConfigured()) return { status: "unavailable" };
  let sawUnavailable = false;
  for (const host of appStoreHosts()) {
    const lookup = await lookupOnHost(host, transactionId);
    if (lookup.status === "ok") return lookup;
    // `unavailable` is a transport verdict, not a verdict about the id: the
    // other host may still hold it, so keep asking — but never downgrade to
    // `not_found` afterwards. Answering `not_found` here would turn "Apple was
    // briefly down" into a permanent 422 and burn a real purchase.
    if (lookup.status === "unavailable") sawUnavailable = true;
  }
  return sawUnavailable ? { status: "unavailable" } : { status: "not_found" };
}

/** One host, one request. `not_found` here means "not in THIS store". */
async function lookupOnHost(host: string, transactionId: string): Promise<TransactionLookup> {
  try {
    const res = await fetch(
      `${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
      {
        headers: { Authorization: `Bearer ${appStoreProviderJwt()}` },
        signal: AbortSignal.timeout(APPSTORE_TIMEOUT_MS),
      },
    );
    if (res.status >= 500) {
      console.warn(`[appstore] transaction lookup ${transactionId} on ${host}: ${res.status}`);
      return { status: "unavailable" };
    }
    if (!res.ok) return { status: "not_found" };
    const body = (await res.json()) as { signedTransactionInfo?: string };
    if (!body.signedTransactionInfo) return { status: "not_found" };
    // The JWS came from Apple over TLS — its payload is trusted here.
    const payload = decodeJwsPayload(body.signedTransactionInfo);
    const transaction = payload ? toTransaction(payload) : null;
    return transaction ? { status: "ok", transaction } : { status: "not_found" };
  } catch (err) {
    console.warn(`[appstore] transaction lookup on ${host} failed:`, err);
    return { status: "unavailable" };
  }
}

/**
 * Consumable product → ticket count. `APPSTORE_TICKET_PRODUCTS` pairs
 * (default `ticket_1:1,ticket_3:3,ticket_6:6`) match either the full
 * product id or its last dot-segment, so `com.gennety.ios.ticket_3` and a
 * bare `ticket_3` both resolve.
 */
export function ticketCountForProduct(productId: string | null): number | null {
  if (!productId) return null;
  const map = new Map(ticketProducts().map((p) => [p.productId, p.tickets]));
  const suffix = productId.split(".").pop() ?? productId;
  return map.get(productId) ?? map.get(suffix) ?? null;
}

/**
 * The configured consumable ladder, in declaration order. Served by
 * `GET /v1/app/config` so the native client loads exactly the products this
 * server will credit: a StoreKit id that only exists in the app is a purchase
 * that takes money and then 422s on report, and the two lists are otherwise
 * maintained in different repositories by hand.
 */
export function ticketProducts(): Array<{ productId: string; tickets: number }> {
  const products: Array<{ productId: string; tickets: number }> = [];
  for (const pair of env.APPSTORE_TICKET_PRODUCTS.split(",")) {
    const [key, raw] = pair.split(":");
    const count = Number(raw);
    if (key && Number.isInteger(count) && count > 0) {
      products.push({ productId: key.trim(), tickets: count });
    }
  }
  return products;
}
