import { prisma } from "@gennety/db";
import {
  APPSTORE_SANDBOX_NOTE,
  isPremiumProduct,
  type AppStoreTransaction,
} from "./appstore.js";
import { env } from "../config.js";
import {
  activateOrExtendPremium,
  recordPremiumLapse,
  revokePremium,
  type RefundedPremiumPeriod,
} from "./premium.js";

/**
 * Gennety Premium via StoreKit 2 auto-renewable subscription (§Premium, the iOS
 * rail — the App Store twin of the Telegram Stars recurring flow). Trust model
 * matches the ticket path: the client JWS / Server Notification is only a
 * pointer; the authoritative transaction is re-fetched from Apple before any
 * state change. Exactly-once application rides `subscription_ledger`'s unique
 * `externalPaymentId` (`appstore:<transactionId>`), so a re-submitted purchase
 * or a redelivered renewal notification is a no-op.
 *
 * `User.premiumExternalId` stores the subscription's `originalTransactionId`,
 * which is stable across renewals — that's how a webhook (which carries no user
 * id) finds the owner.
 */

export type AppStorePremiumResult =
  | { status: "activated"; premiumUntil: string | null }
  | { status: "already_processed" }
  | { status: "revoked" }
  | { status: "invalid"; reason: "wrong_bundle" | "not_premium" | "no_expiry" | "unknown_owner" };

/**
 * A notification can also report a plain lapse, which the client purchase path
 * never does — kept out of `AppStorePremiumResult` so that route's exhaustive
 * switch does not grow a case it cannot reach.
 */
export type AppStorePremiumNotificationResult = AppStorePremiumResult | { status: "lapsed" };

/** The recurring anchor stored on the user for a subscription transaction. */
function anchorOf(tx: AppStoreTransaction): string {
  return tx.originalTransactionId ?? tx.transactionId;
}

/** Apple's dates for the refunded transaction, as the coverage it had bought. */
function refundedPeriodOf(tx: AppStoreTransaction): RefundedPremiumPeriod {
  return {
    start: tx.purchaseDate != null ? new Date(tx.purchaseDate) : null,
    end: tx.expiresDate != null ? new Date(tx.expiresDate) : null,
  };
}

/**
 * Apply a verified premium subscription transaction for a KNOWN user (the client
 * `POST /v1/premium/appstore/transaction` path — userId from JWT). Activates or
 * extends to Apple's authoritative `expiresDate`; a revoked/refunded transaction
 * takes back only that transaction's unused days instead.
 */
export async function applyAppStorePremium(
  userId: string,
  tx: AppStoreTransaction,
): Promise<AppStorePremiumResult> {
  if (tx.bundleId !== env.APPSTORE_BUNDLE_ID) {
    return { status: "invalid", reason: "wrong_bundle" };
  }
  if (!isPremiumProduct(tx.productId)) {
    return { status: "invalid", reason: "not_premium" };
  }
  if (tx.revocationDate !== null) {
    // Only this transaction's unused days go back — not the months the user
    // holds from a package, a referral or a promo.
    await revokePremium({
      userId,
      externalPaymentId: `appstore:${tx.transactionId}:refund`,
      provider: "app_store",
      refunded: refundedPeriodOf(tx),
    });
    return { status: "revoked" };
  }
  if (tx.expiresDate == null) {
    return { status: "invalid", reason: "no_expiry" };
  }

  const sandbox = tx.environment === "Sandbox";
  const result = await activateOrExtendPremium({
    userId,
    provider: "app_store",
    periodEnd: new Date(tx.expiresDate),
    ...(tx.purchaseDate != null ? { periodStart: new Date(tx.purchaseDate) } : {}),
    externalPaymentId: `appstore:${tx.transactionId}`,
    recurringAnchor: anchorOf(tx),
    currency: "USD",
    // Honoured (App Review buys in the sandbox against this server), labelled
    // so the row and the founder feed are never counted as revenue.
    ...(sandbox ? { note: APPSTORE_SANDBOX_NOTE, sandbox: true } : {}),
  });
  return result.applied
    ? { status: "activated", premiumUntil: result.premiumUntil?.toISOString() ?? null }
    : { status: "already_processed" };
}

/**
 * Handle a verified subscription transaction from an App Store Server
 * Notification (renewal, expiry, refund/revoke) — there is no JWT here, so the
 * owner is found by the stable `originalTransactionId` anchor. A renewal
 * extends; a refund takes back that transaction's unused days; a lapse stops
 * the renewal and leaves the dates alone.
 *
 * `_notificationType` stays in the signature because the caller routes and logs
 * by it, but it deliberately reaches no decision here: it arrives from an
 * unverified payload, and what the entitlement should be is answered by the
 * transaction Apple returned (see the verdict below).
 */
export async function handleAppStorePremiumNotification(
  tx: AppStoreTransaction,
  _notificationType: string,
): Promise<AppStorePremiumNotificationResult> {
  if (!isPremiumProduct(tx.productId)) {
    return { status: "invalid", reason: "not_premium" };
  }
  const owner = await prisma.user.findFirst({
    where: { premiumExternalId: anchorOf(tx) },
    select: { id: true },
  });
  if (!owner) return { status: "invalid", reason: "unknown_owner" };

  /**
   * The verdict comes from the transaction Apple returned, never from
   * `notificationType`.
   *
   * The webhook is unauthenticated by construction (Apple sends no headers) and
   * its `signedPayload` signature is not verified here, so the type string is
   * attacker-controlled: anyone able to name a transaction id could post
   * `EXPIRED` for it and end a subscription Apple reports as live and paid
   * through. Deriving `ending` from `revocationDate`/`expiresDate` restores the
   * property this module's header already claims — the notification is only a
   * pointer to what changed, and every consequence re-reads Apple.
   *
   * The same reason keeps the type out of the idempotency key: a key built from
   * untrusted input lets one caller mint several of them for one revocation
   * (`EXPIRED`, then `REVOKE`) and slip past the ledger's exactly-once guard.
   * The key now names the CAUSE, which is what the ledger is deduplicating.
   */
  if (tx.revocationDate !== null) {
    await revokePremium({
      userId: owner.id,
      externalPaymentId: `appstore:${tx.transactionId}:refund`,
      provider: "app_store",
      refunded: refundedPeriodOf(tx),
    });
    return { status: "revoked" };
  }

  const lapsed = tx.expiresDate !== null && tx.expiresDate <= Date.now();
  if (lapsed) {
    // An ordinary lapse ends nothing by itself: entitlement is date-based, and
    // `premiumUntil` also carries months this subscription never paid for. It
    // only means the subscription no longer renews — unless Apple has already
    // renewed past this transaction (a redelivered notification for an older
    // period), in which case it means nothing at all.
    const renewedPast = await prisma.subscriptionLedger.findFirst({
      where: {
        userId: owner.id,
        provider: "app_store",
        event: { in: ["started", "renewed"] },
        periodEnd: { gt: new Date(tx.expiresDate ?? 0) },
      },
      select: { id: true },
    });
    if (renewedPast) return { status: "already_processed" };
    await recordPremiumLapse(owner.id, `appstore:${tx.transactionId}:expired`, "app_store");
    return { status: "lapsed" };
  }
  return applyAppStorePremium(owner.id, tx);
}

/** Notification types that (re)grant/extend the entitlement. */
export const PREMIUM_RENEW_NOTIFICATIONS = new Set([
  "SUBSCRIBED",
  "DID_RENEW",
  "OFFER_REDEEMED",
]);
