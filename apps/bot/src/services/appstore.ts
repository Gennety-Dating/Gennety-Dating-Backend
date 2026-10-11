import { createHmac } from "node:crypto";
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

/**
 * Which Apple store minted a transaction. `Sandbox` covers TestFlight, App
 * Review and every other purchase where no money moved.
 */
export type AppStoreEnvironment = "Production" | "Sandbox";

/**
 * `SubscriptionLedger.note` stamped on a sandbox Premium row. Sandbox purchases
 * are still honoured — App Review buys in the sandbox against the production
 * server, and refusing them fails the review — but they are not revenue, so
 * the row says so for anyone summing money off the ledger.
 */
export const APPSTORE_SANDBOX_NOTE = "appstore-sandbox";

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
   * When this transaction's period began (ms epoch). For a subscription
   * renewal that is the start of the renewed period, which is what a refund
   * needs: only the part of `purchaseDate..expiresDate` still ahead of now was
   * handed back.
   */
  purchaseDate: number | null;
  /**
   * The store that minted it. Read from Apple's own `environment` field, and
   * from the host that answered when an older payload omits it — a transaction
   * only exists in the store that created it.
   */
  environment: AppStoreEnvironment;
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
  /**
   * Who the app said was buying, as a UUID the client sets at purchase time
   * (`Product.PurchaseOption.appAccountToken`) and Apple echoes back.
   *
   * `null` for anything bought before the client started sending it — which is
   * why the check that reads this is "verify when present" rather than
   * "require". Ownership was otherwise decided by a race: `externalPaymentId`
   * is unique, so whoever submitted a given `transactionId` first got the
   * tickets.
   */
  appAccountToken: string | null;
}

export type TransactionLookup =
  | { status: "ok"; transaction: AppStoreTransaction }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * Apple's `environment` is `Production` or `Sandbox`; anything else it might
 * grow (Xcode's local store) moves no money either, so only an explicit
 * `Production` counts as one. An absent field falls back to the store that
 * answered.
 */
function environmentOf(payload: Record<string, unknown>, host: string): AppStoreEnvironment {
  if (payload.environment === "Production") return "Production";
  if (typeof payload.environment === "string") return "Sandbox";
  return host === APPSTORE_PRODUCTION_HOST ? "Production" : "Sandbox";
}

function toTransaction(
  payload: Record<string, unknown>,
  host: string,
): AppStoreTransaction | null {
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
    appAccountToken:
      typeof payload.appAccountToken === "string" && payload.appAccountToken
        ? payload.appAccountToken.toLowerCase()
        : null,
    expiresDate: typeof payload.expiresDate === "number" ? payload.expiresDate : null,
    purchaseDate: typeof payload.purchaseDate === "number" ? payload.purchaseDate : null,
    environment: environmentOf(payload, host),
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
 * The `appAccountToken` this user's purchases are made under (`GET /v1/me`).
 *
 * StoreKit takes a UUID, Apple echoes it back on every transaction, and it is
 * the only field in a transaction that says who was buying. Deterministic per
 * user — the first 16 bytes of HMAC-SHA256("appAccountToken:" + userId) shaped
 * into a version-4 UUID — so it needs no column and never changes: a renewal
 * years from now carries the token of the original purchase. Keyed rather than
 * the raw user id so the token Apple holds says nothing about our ids.
 */
export function appAccountTokenFor(userId: string): string {
  // JWT_SECRET is required at boot (config validation), so the empty fallback
  // only ever applies in tests.
  const key = env.APP_ACCOUNT_TOKEN_SECRET || env.JWT_SECRET || "";
  const bytes = createHmac("sha256", key)
    .update(`appAccountToken:${userId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Whether a verified transaction names a DIFFERENT buyer than `userId`.
 *
 * Verified when present rather than required: builds in the wild do not set the
 * token, and refusing their purchases would break real money. The raw user id
 * is accepted as well as the derived token — it is what the server compared
 * against before the token had a contract, so a transaction minted that way
 * still belongs to its buyer. Case carries no meaning in a UUID.
 */
export function boughtByAnotherUser(tx: AppStoreTransaction, userId: string): boolean {
  if (tx.appAccountToken === null) return false;
  const token = tx.appAccountToken.toLowerCase();
  return token !== appAccountTokenFor(userId) && token !== userId.toLowerCase();
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

/**
 * Apple's documented "this id is not a transaction here" error codes:
 * `TransactionIdNotFoundError` (4040010) and `InvalidTransactionIdError`
 * (4000006). The second is a malformed id — forged or garbage — which no retry
 * will ever fix.
 */
const APPSTORE_TRANSACTION_NOT_FOUND_CODES: ReadonlySet<number> = new Set([4040010, 4000006]);

/** Apple's numeric `errorCode` from an error body, when there is one. */
async function appStoreErrorCode(res: Response): Promise<number | null> {
  try {
    const body = (await res.json()) as { errorCode?: unknown };
    return typeof body.errorCode === "number" ? body.errorCode : null;
  } catch {
    // No JSON body (a proxy's HTML page, an empty 429): the status decides.
    return null;
  }
}

/**
 * Whether a non-2xx answer is a verdict on the transaction id itself. Any 404
 * counts — the id is the only variable in the path — but a 400 only with
 * Apple's own invalid-id code, since a 400 can also be about our request.
 */
function isTransactionNotFound(status: number, errorCode: number | null): boolean {
  if (status === 404) return true;
  return errorCode !== null && APPSTORE_TRANSACTION_NOT_FOUND_CODES.has(errorCode);
}

type AppStoreGet =
  | { status: "ok"; body: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "unavailable" };

/** One authenticated GET against one App Store Server API host. */
async function appStoreGet(host: string, path: string): Promise<AppStoreGet> {
  try {
    const res = await fetch(`${host}${path}`, {
      headers: { Authorization: `Bearer ${appStoreProviderJwt()}` },
      signal: AbortSignal.timeout(APPSTORE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Only an answer ABOUT THE ID may say `not_found`: the route turns it into
      // a 422, which is the one reply the client finishes a paid transaction on.
      // Everything else — our token rejected (401), the key revoked (403),
      // Apple rate-limiting us (429), a 5xx — is our or Apple's trouble, says
      // nothing about the purchase, and must come back as retry-later. Mapping
      // every non-2xx to `not_found` used to burn real purchases whenever the
      // provider token went bad.
      const errorCode = await appStoreErrorCode(res);
      if (isTransactionNotFound(res.status, errorCode)) return { status: "not_found" };
      if (res.status === 401) {
        // A token Apple refuses is not one to keep reusing for 50 minutes.
        cachedJwt = null;
      }
      console.warn(
        `[appstore] ${path} on ${host}: ${res.status}` +
          (errorCode != null ? ` (errorCode ${errorCode})` : ""),
      );
      return { status: "unavailable" };
    }
    const body = (await res.json()) as unknown;
    return typeof body === "object" && body !== null
      ? { status: "ok", body: body as Record<string, unknown> }
      : { status: "not_found" };
  } catch (err) {
    console.warn(`[appstore] ${path} on ${host} failed:`, err);
    return { status: "unavailable" };
  }
}

/** One host, one request. `not_found` here means "not in THIS store". */
async function lookupOnHost(host: string, transactionId: string): Promise<TransactionLookup> {
  const got = await appStoreGet(
    host,
    `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
  );
  if (got.status !== "ok") return got;
  const signed = got.body.signedTransactionInfo;
  if (typeof signed !== "string" || !signed) return { status: "not_found" };
  // The JWS came from Apple over TLS — its payload is trusted here.
  const payload = decodeJwsPayload(signed);
  const transaction = payload ? toTransaction(payload, host) : null;
  if (!transaction) return { status: "not_found" };
  // Logged once here rather than at each rail, so every sandbox purchase the
  // production server honours (App Review, TestFlight) leaves a line whichever
  // product it bought.
  if (transaction.environment === "Sandbox") {
    console.info(
      `[appstore] sandbox transaction ${transactionId} product=${transaction.productId ?? "?"} ` +
        "— honoured, not revenue",
    );
  }
  return { status: "ok", transaction };
}

export type AutoRenewLookup =
  | { status: "ok"; autoRenew: boolean }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * Whether a subscription will renew, from Apple's own renewal info
 * (`GET /inApps/v1/subscriptions/{transactionId}` → `signedRenewalInfo`).
 *
 * `DID_CHANGE_RENEWAL_STATUS` says the user switched renewal on or off, but its
 * payload is unverified (see the webhook), so the answer is re-read from Apple
 * the same way every transaction is. Same two-store walk as
 * {@link getVerifiedTransaction}.
 */
export async function getSubscriptionAutoRenew(
  originalTransactionId: string,
): Promise<AutoRenewLookup> {
  if (!appStoreConfigured()) return { status: "unavailable" };
  let sawUnavailable = false;
  for (const host of appStoreHosts()) {
    const got = await appStoreGet(
      host,
      `/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`,
    );
    if (got.status === "unavailable") {
      sawUnavailable = true;
      continue;
    }
    if (got.status === "not_found") continue;
    const autoRenew = autoRenewFromStatuses(got.body, originalTransactionId);
    if (autoRenew !== null) return { status: "ok", autoRenew };
  }
  return sawUnavailable ? { status: "unavailable" } : { status: "not_found" };
}

/** `autoRenewStatus` (1 = on) of this subscription's latest renewal info. */
function autoRenewFromStatuses(
  body: Record<string, unknown>,
  originalTransactionId: string,
): boolean | null {
  const groups = Array.isArray(body.data) ? body.data : [];
  for (const group of groups) {
    const last =
      typeof group === "object" && group !== null && Array.isArray(group.lastTransactions)
        ? (group.lastTransactions as unknown[])
        : [];
    for (const item of last) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (entry.originalTransactionId !== originalTransactionId) continue;
      const renewal =
        typeof entry.signedRenewalInfo === "string"
          ? decodeJwsPayload(entry.signedRenewalInfo)
          : null;
      if (renewal && typeof renewal.autoRenewStatus === "number") {
        return renewal.autoRenewStatus === 1;
      }
    }
  }
  return null;
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
