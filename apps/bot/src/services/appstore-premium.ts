import { prisma } from "@gennety/db";
import {
  APPSTORE_SANDBOX_NOTE,
  boughtByAnotherUser,
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

/** The client report path can also refuse a subscription bound to someone else. */
export type AppStorePremiumReportResult =
  | AppStorePremiumResult
  | { status: "invalid"; reason: "wrong_owner" };

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
 * The client report path (`POST /v1/premium/appstore/transaction`): whose
 * subscription is this, before anything is applied.
 *
 * Nothing used to ask. Any signed-in account that re-sent a subscriber's JWS
 * got Premium from it — and on a refunded one, had days taken from itself for a
 * purchase it never made. Two answers say the transaction is someone else's:
 * the `appAccountToken` Apple echoes back names another buyer, or the
 * subscription (its stable `originalTransactionId`, or this very charge) is
 * already bound to another account. The first account to report a subscription
 * keeps it; the webhook, which finds the owner by that binding, agrees.
 */
export async function reportAppStorePremium(
  userId: string,
  tx: AppStoreTransaction,
): Promise<AppStorePremiumReportResult> {
  if (boughtByAnotherUser(tx, userId)) {
    console.error(
      `[appstore-premium] transaction ${tx.transactionId} was bought by ` +
        `${tx.appAccountToken} but claimed by ${userId}`,
    );
    return { status: "invalid", reason: "wrong_owner" };
  }
  const [boundOwner, charge] = await Promise.all([
    prisma.user.findFirst({
      where: { premiumExternalId: anchorOf(tx), NOT: { id: userId } },
      select: { id: true },
    }),
    prisma.subscriptionLedger.findUnique({
      where: { externalPaymentId: `appstore:${tx.transactionId}` },
      select: { userId: true },
    }),
  ]);
  const otherOwner =
    boundOwner?.id ?? (charge?.userId && charge.userId !== userId ? charge.userId : null);
  if (otherOwner) {
    console.error(
      `[appstore-premium] subscription ${anchorOf(tx)} belongs to ${otherOwner} ` +
        `but was reported by ${userId}`,
    );
    return { status: "invalid", reason: "wrong_owner" };
  }
  return applyAppStorePremium(userId, tx);
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

/**
 * `DID_CHANGE_RENEWAL_STATUS`: mirror Apple's verified `autoRenewStatus` onto
 * `premiumAutoRenew` for the subscription's owner. Dates are untouched — a
 * subscriber who turns renewal off keeps what they paid for — but the head
 * stops claiming it renews, which the cancel flow, the recurring-checkout guard
 * and the expiry reminders all read. Before this the flag only moved at the
 * eventual `EXPIRED`, so for the rest of the period the server believed in a
 * renewal the user had already cancelled.
 *
 * Scoped to the owner whose recurring anchor is THIS subscription, so a stale
 * notification cannot flip a head that has since moved to another one.
 */
export async function syncAppStorePremiumAutoRenew(
  tx: AppStoreTransaction,
  autoRenew: boolean,
): Promise<{ status: "updated" | "unchanged" | "unknown_owner" }> {
  if (!isPremiumProduct(tx.productId)) return { status: "unknown_owner" };
  const moved = await prisma.user.updateMany({
    where: { premiumExternalId: anchorOf(tx), premiumAutoRenew: !autoRenew },
    data: { premiumAutoRenew: autoRenew },
  });
  if (moved.count > 0) return { status: "updated" };
  const owner = await prisma.user.findFirst({
    where: { premiumExternalId: anchorOf(tx) },
    select: { id: true },
  });
  return { status: owner ? "unchanged" : "unknown_owner" };
}

/** Notification types that (re)grant/extend the entitlement. */
export const PREMIUM_RENEW_NOTIFICATIONS = new Set([
  "SUBSCRIBED",
  "DID_RENEW",
  "OFFER_REDEEMED",
]);
