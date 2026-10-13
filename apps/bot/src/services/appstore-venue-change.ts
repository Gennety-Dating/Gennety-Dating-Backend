import type { Api, RawApi } from "grammy";

import { prisma } from "@gennety/db";

import { env } from "../config.js";
import {
  boughtByAnotherUser,
  getVerifiedTransaction,
  type AppStoreTransaction,
} from "./appstore.js";
import {
  notifyFounderAppStoreUnclaimed,
  notifyFounderPurchaseRefunded,
  notifyFounderRefundReversed,
} from "./founder-notify.js";
import {
  APPSTORE_PAYMENT_PREFIX,
  VENUE_PURCHASE_REFUND_MANUAL,
  VENUE_PURCHASE_REFUNDED_APPSTORE,
} from "./venue-change-refund.js";
import { settleVenueChangeFromAppStore } from "../handlers/matching/venue-change.js";

/**
 * StoreKit 2 → one settled venue change (2026-09-12).
 *
 * The shape is `appstore-tickets.ts`'s, deliberately: the client's JWS is
 * decoded route-side ONLY to lift a transaction id out of it, and every fact
 * used to decide anything comes back from Apple. What differs is what the
 * purchase buys — tickets credit a wallet, this claims a specific match's
 * pending change — and so what a failure means. A wallet credit can always be
 * applied; a change can be bought a moment too late.
 */

export type VenueChangePurchaseResult =
  | { status: "settled" }
  /** Already applied — the client may `finish()` this transaction. */
  | { status: "already_processed" }
  | {
      status: "invalid";
      reason:
        | "unknown_transaction"
        | "wrong_bundle"
        | "unknown_product"
        | "revoked"
        | "wrong_owner";
    }
  /**
   * Verified and charged, but the change could not be claimed — the partner
   * settled or the session lapsed in the meantime. The purchase is parked for
   * a manual refund and the client is told plainly; it must NOT be presented
   * as a refund that has happened.
   */
  | { status: "unclaimed"; reason: string }
  | { status: "unavailable" };

/** Full product id or its last dot-segment, as every other rail matches. */
export function isVenueChangeProduct(productId: string | null): boolean {
  if (!productId) return false;
  const want = env.VENUE_CHANGE_APPSTORE_PRODUCT_ID;
  return productId === want || productId.split(".").pop() === want;
}

export async function purchaseVenueChange(
  api: Api<RawApi>,
  userId: string,
  matchId: string,
  transactionId: string,
): Promise<VenueChangePurchaseResult> {
  const lookup = await getVerifiedTransaction(transactionId);
  if (lookup.status === "unavailable") return { status: "unavailable" };
  if (lookup.status === "not_found") {
    return { status: "invalid", reason: "unknown_transaction" };
  }

  const tx = lookup.transaction;
  if (tx.bundleId !== env.APPSTORE_BUNDLE_ID) {
    return { status: "invalid", reason: "wrong_bundle" };
  }
  if (tx.revocationDate !== null) {
    return { status: "invalid", reason: "revoked" };
  }
  // Ownership, on the same terms as the ticket rail: `appAccountToken` is the
  // client-set UUID Apple echoes back and the only field that says who was
  // buying. Verified when present rather than required, because a build in the
  // wild that does not set it must not have its purchases refused.
  if (boughtByAnotherUser(tx, userId)) {
    console.error(
      `[venue-change] transaction ${tx.transactionId} was bought by ` +
        `${tx.appAccountToken} but claimed by ${userId}`,
    );
    return { status: "invalid", reason: "wrong_owner" };
  }
  if (!isVenueChangeProduct(tx.productId)) {
    return { status: "invalid", reason: "unknown_product" };
  }

  const settled = await settleVenueChangeFromAppStore(
    api,
    userId,
    matchId,
    tx.transactionId,
    tx.priceCents,
    tx.environment === "Sandbox",
  );
  if (settled.ok) return { status: "settled" };

  // A re-report is answered from the stored row: ok when it settled, the same
  // refusal when it was parked, retry-later while a first report is in flight.
  if (settled.reason === "processing") return { status: "unavailable" };
  if (settled.reason === "wrong_owner") return { status: "invalid", reason: "wrong_owner" };
  // The two that mean "this purchase never became a change" are the ones the
  // client must not retry.
  if (settled.reason === "match-not-found" || settled.reason === "not-participant") {
    // Apple has taken the money and nothing was written: the refusal happens
    // before the purchase row. Without this notice the client finished the
    // transaction and the charge left no trace anywhere — Prime Time parks the
    // same case as `refund_manual` and alerts; this is that alert.
    void notifyFounderAppStoreUnclaimed({
      userId,
      kind: "venue_change",
      externalPaymentId: `${APPSTORE_PAYMENT_PREFIX}${tx.transactionId}`,
      reason: settled.reason,
      matchId,
      amountCents: tx.priceCents,
      currency: tx.currency ?? null,
      sandbox: tx.environment === "Sandbox",
    }).catch(() => undefined);
    return { status: "invalid", reason: "unknown_transaction" };
  }
  return { status: "unclaimed", reason: settled.reason };
}

export type VenueChangeAppStoreRefundResult =
  | { status: "not_revoked" }
  | { status: "no_purchase" }
  | { status: "already_recorded" }
  | { status: "recorded" };

/**
 * Apple refunded or revoked a venue change (App Store Server Notification).
 *
 * Before this the webhook sent such a refund to the ticket ledger, found no
 * credit there and acknowledged it without a trace. Recorded and announced
 * now, on the Prime Time pass's terms: the change is NOT undone — the pair may
 * already be heading to the new place, and moving a date under them is worse
 * than the loss — so the founder notice is where the loss lands.
 *
 * `tx` is Apple's authoritative transaction, re-fetched by the webhook.
 */
export async function refundVenueChangeAppStoreTransaction(
  tx: AppStoreTransaction,
): Promise<VenueChangeAppStoreRefundResult> {
  if (tx.revocationDate === null) return { status: "not_revoked" };
  const externalPaymentId = `${APPSTORE_PAYMENT_PREFIX}${tx.transactionId}`;

  const row = await prisma.venueChangePurchase.findUnique({
    where: { externalPaymentId },
    select: { id: true, userId: true, status: true },
  });
  if (!row) return { status: "no_purchase" };
  if (row.status === VENUE_PURCHASE_REFUNDED_APPSTORE) return { status: "already_recorded" };

  // Conditional on the status just read, so Apple's retries (and a report
  // racing this) record — and announce — the refund once.
  const moved = await prisma.venueChangePurchase.updateMany({
    where: { id: row.id, status: row.status },
    data: { status: VENUE_PURCHASE_REFUNDED_APPSTORE, resolvedAt: new Date() },
  });
  if (moved.count === 0) return { status: "already_recorded" };

  void notifyFounderPurchaseRefunded({
    userId: row.userId,
    kind: "venue_change",
    amountCents: tx.priceCents,
    currency: tx.currency,
    reason:
      row.status === VENUE_PURCHASE_REFUND_MANUAL
        ? "Apple вернул покупку (refund/revoke) — ручной возврат больше не нужен"
        : "Apple вернул покупку (refund/revoke); новое место остаётся в силе",
    externalPaymentId,
  });
  return { status: "recorded" };
}

export type VenueChangeAppStoreReversalResult =
  | { status: "still_revoked" }
  | { status: "no_refund" }
  | { status: "announced" };

/**
 * `REFUND_REVERSED` for a venue change: announced to the founder, nothing
 * re-applied. The change itself was never taken back by the refund, and the
 * date it moved has likely moved on since — re-running a venue change is a
 * product decision a webhook must not make. The row stays `refunded_appstore`
 * (no write), so a redelivered notification announces again; Apple only
 * redelivers on a non-2xx, so that is rare.
 */
export async function reverseVenueChangeAppStoreRefund(
  tx: AppStoreTransaction,
): Promise<VenueChangeAppStoreReversalResult> {
  if (tx.revocationDate !== null) return { status: "still_revoked" };
  const externalPaymentId = `${APPSTORE_PAYMENT_PREFIX}${tx.transactionId}`;
  const row = await prisma.venueChangePurchase.findUnique({
    where: { externalPaymentId },
    select: { userId: true, status: true },
  });
  if (!row || row.status !== VENUE_PURCHASE_REFUNDED_APPSTORE) return { status: "no_refund" };

  void notifyFounderRefundReversed({
    userId: row.userId,
    kind: "venue_change",
    restored:
      "ничего не переприменено — смена места не отменялась возвратом; " +
      "статус покупки остаётся refunded_appstore, решить вручную",
    externalPaymentId,
    sandbox: tx.environment === "Sandbox",
  });
  return { status: "announced" };
}
