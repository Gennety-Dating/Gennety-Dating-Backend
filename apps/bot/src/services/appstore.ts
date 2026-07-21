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

export function appStoreHost(): string {
  return env.APPSTORE_ENVIRONMENT === "production"
    ? "https://api.storekit.itunes.apple.com"
    : "https://api.storekit-sandbox.itunes.apple.com";
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
  try {
    const res = await fetch(
      `${appStoreHost()}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
      {
        headers: { Authorization: `Bearer ${appStoreProviderJwt()}` },
        signal: AbortSignal.timeout(APPSTORE_TIMEOUT_MS),
      },
    );
    if (res.status >= 500) {
      console.warn(`[appstore] transaction lookup ${transactionId}: ${res.status}`);
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
    console.warn("[appstore] transaction lookup failed:", err);
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
  const map = new Map<string, number>();
  for (const pair of env.APPSTORE_TICKET_PRODUCTS.split(",")) {
    const [key, raw] = pair.split(":");
    const count = Number(raw);
    if (key && Number.isInteger(count) && count > 0) map.set(key.trim(), count);
  }
  const suffix = productId.split(".").pop() ?? productId;
  return map.get(productId) ?? map.get(suffix) ?? null;
}
