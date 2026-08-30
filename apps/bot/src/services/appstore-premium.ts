import { prisma } from "@gennety/db";
import {
  isPremiumProduct,
  type AppStoreTransaction,
} from "./appstore.js";
import { env } from "../config.js";
import { activateOrExtendPremium, revokePremium } from "./premium.js";

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

/** The recurring anchor stored on the user for a subscription transaction. */
function anchorOf(tx: AppStoreTransaction): string {
  return tx.originalTransactionId ?? tx.transactionId;
}

/**
 * Apply a verified premium subscription transaction for a KNOWN user (the client
 * `POST /v1/premium/appstore/transaction` path — userId from JWT). Activates or
 * extends to Apple's authoritative `expiresDate`; a revoked/refunded transaction
 * ends the entitlement instead.
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
    await revokePremium(userId, `appstore:${tx.transactionId}:refund`, "refunded");
    return { status: "revoked" };
  }
  if (tx.expiresDate == null) {
    return { status: "invalid", reason: "no_expiry" };
  }

  const result = await activateOrExtendPremium({
    userId,
    provider: "app_store",
    periodEnd: new Date(tx.expiresDate),
    externalPaymentId: `appstore:${tx.transactionId}`,
    recurringAnchor: anchorOf(tx),
    currency: "USD",
  });
  return result.applied
    ? { status: "activated", premiumUntil: result.premiumUntil?.toISOString() ?? null }
    : { status: "already_processed" };
}

/**
 * Handle a verified subscription transaction from an App Store Server
 * Notification (renewal, expiry, refund/revoke) — there is no JWT here, so the
 * owner is found by the stable `originalTransactionId` anchor. A renewal
 * extends; a revoked or lapsed transaction ends the entitlement.
 *
 * `_notificationType` stays in the signature because the caller routes and logs
 * by it, but it deliberately reaches no decision here: it arrives from an
 * unverified payload, and what the entitlement should be is answered by the
 * transaction Apple returned (see the verdict below).
 */
export async function handleAppStorePremiumNotification(
  tx: AppStoreTransaction,
  _notificationType: string,
): Promise<AppStorePremiumResult> {
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
  const refunded = tx.revocationDate !== null;
  const lapsed = tx.expiresDate !== null && tx.expiresDate <= Date.now();
  if (refunded || lapsed) {
    await revokePremium(
      owner.id,
      `appstore:${tx.transactionId}:${refunded ? "refund" : "expired"}`,
      refunded ? "refunded" : "expired",
    );
    return { status: "revoked" };
  }
  return applyAppStorePremium(owner.id, tx);
}

/** Notification types that (re)grant/extend the entitlement. */
export const PREMIUM_RENEW_NOTIFICATIONS = new Set([
  "SUBSCRIBED",
  "DID_RENEW",
  "OFFER_REDEEMED",
]);
