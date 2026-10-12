import { Router, type Request, type Response } from "express";
import {
  appStoreConfigured,
  decodeJwsPayload,
  getSubscriptionAutoRenew,
  getVerifiedTransaction,
  isPremiumProduct,
  type AppStoreTransaction,
} from "../../services/appstore.js";
import {
  refundAppStoreTransaction,
  reverseAppStoreTicketRefund,
} from "../../services/appstore-tickets.js";
import {
  isVenueChangeProduct,
  refundVenueChangeAppStoreTransaction,
  reverseVenueChangeAppStoreRefund,
} from "../../services/appstore-venue-change.js";
import {
  refundPrimeTimeAppStoreTransaction,
  reversePrimeTimeAppStoreRefund,
} from "../../services/appstore-prime-time.js";
import { isPrimeTimeProduct } from "../../services/prime-time.js";
import {
  isWishlistProduct,
  refundWishlistAppStoreTransaction,
} from "../../services/appstore-wishlist.js";
import {
  handleAppStorePremiumNotification,
  PREMIUM_RENEW_NOTIFICATIONS,
  reverseAppStorePremiumRefund,
  syncAppStorePremiumAutoRenew,
} from "../../services/appstore-premium.js";

/**
 * App Store Server Notifications V2 (`POST /v1/webhooks/appstore`).
 *
 * Trust model mirrors the client purchase path: the signedPayload is decoded
 * ONLY to learn which transaction changed; every consequential fact is
 * re-fetched from the App Store Server API. A forged webhook can therefore
 * at worst trigger a lookup of a transaction that turns out fine — never a
 * state change. Refund/revoke notifications claw back the ticket credit
 * (exactly-once via the ledger's unique external id).
 *
 * Responses: 200 on anything conclusively handled or ignorable, 500 when
 * the authoritative lookup is unavailable so Apple retries later.
 */
export const appStoreWebhookRouter: Router = Router();

const REFUND_NOTIFICATION_TYPES = new Set(["REFUND", "REVOKE", "CONSUMPTION_REQUEST"]);
/**
 * Apple took a refund back (the customer disputed it and lost, or Apple
 * reversed its own decision). Like every type here it is untrusted: each
 * reversal handler acts only when Apple's re-fetched transaction no longer
 * carries a `revocationDate` AND our own refund marker exists for it.
 */
const REFUND_REVERSED = "REFUND_REVERSED";
// §Premium subscription lifecycle notifications we consume (renew + end).
const PREMIUM_NOTIFICATION_TYPES = new Set([
  ...PREMIUM_RENEW_NOTIFICATIONS,
  "EXPIRED",
  "GRACE_PERIOD_EXPIRED",
  "REFUND",
  "REVOKE",
  "DID_CHANGE_RENEWAL_STATUS",
]);

appStoreWebhookRouter.post("/", async (req: Request, res: Response): Promise<void> => {
  const signedPayload =
    typeof req.body?.signedPayload === "string" ? req.body.signedPayload : "";
  if (!signedPayload) {
    res.status(400).json({ error: "Missing signedPayload" });
    return;
  }

  const payload = decodeJwsPayload(signedPayload);
  const notificationType =
    payload && typeof payload.notificationType === "string" ? payload.notificationType : "";
  const data =
    payload && typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : null;
  const signedTransactionInfo =
    data && typeof data.signedTransactionInfo === "string" ? data.signedTransactionInfo : "";
  const txPayload = signedTransactionInfo ? decodeJwsPayload(signedTransactionInfo) : null;
  const transactionId =
    txPayload && typeof txPayload.transactionId === "string" ? txPayload.transactionId : "";

  if (!notificationType || !transactionId) {
    // Malformed or a notification shape we don't consume — ack so Apple
    // doesn't retry forever.
    res.json({ ok: true });
    return;
  }

  // Route by product: a premium-subscription notification goes to the §Premium
  // handler; a ticket refund/revoke to the wallet claw-back. The untrusted
  // productId is used ONLY for routing — every consequence re-fetches Apple's
  // authoritative transaction below.
  const untrustedProductId =
    txPayload && typeof txPayload.productId === "string" ? txPayload.productId : null;
  const isPremium =
    isPremiumProduct(untrustedProductId) && PREMIUM_NOTIFICATION_TYPES.has(notificationType);

  const isRefundReversal = notificationType === REFUND_REVERSED;
  if (!isPremium && !isRefundReversal && !REFUND_NOTIFICATION_TYPES.has(notificationType)) {
    res.json({ ok: true, ignored: notificationType });
    return;
  }

  if (!appStoreConfigured()) {
    res.status(500).json({ error: "Not configured" });
    return;
  }
  const lookup = await getVerifiedTransaction(transactionId);
  if (lookup.status === "unavailable") {
    res.status(500).json({ error: "Lookup unavailable" });
    return;
  }
  if (lookup.status === "not_found") {
    res.json({ ok: true, ignored: "unknown_transaction" });
    return;
  }

  if (isRefundReversal) {
    const result = await reverseRefund(lookup.transaction);
    console.log(`[appstore-webhook] ${notificationType} tx=${transactionId} -> ${result}`);
    res.json({ ok: true, result });
    return;
  }

  if (isPremium) {
    const premium = await handleAppStorePremiumNotification(lookup.transaction, notificationType);
    console.log(
      `[appstore-webhook] premium ${notificationType} tx=${transactionId} -> ${premium.status}`,
    );
    if (notificationType === "DID_CHANGE_RENEWAL_STATUS") {
      // The user switched renewal on or off. Which way is re-read from Apple's
      // renewal info — the notification's own `subtype` is as unverified as
      // its type — and a lookup that cannot answer asks Apple to retry.
      const anchor = lookup.transaction.originalTransactionId ?? lookup.transaction.transactionId;
      const renewal = await getSubscriptionAutoRenew(anchor);
      if (renewal.status === "unavailable") {
        res.status(500).json({ error: "Lookup unavailable" });
        return;
      }
      if (renewal.status === "ok") {
        const synced = await syncAppStorePremiumAutoRenew(lookup.transaction, renewal.autoRenew);
        console.log(
          `[appstore-webhook] premium autoRenew=${renewal.autoRenew} tx=${transactionId} -> ${synced.status}`,
        );
      }
    }
    res.json({ ok: true, result: premium.status });
    return;
  }

  // A venue change bought in the app: recorded and announced, the change
  // stays (`appstore-venue-change.ts`). Before this branch it fell through to
  // the ticket ledger, found nothing and was acknowledged without a trace.
  if (isVenueChangeProduct(lookup.transaction.productId)) {
    const venue = await refundVenueChangeAppStoreTransaction(lookup.transaction);
    console.log(
      `[appstore-webhook] venue-change ${notificationType} tx=${transactionId} -> ${venue.status}`,
    );
    res.json({ ok: true, result: venue.status });
    return;
  }

  // A Prime Time pass has no wallet to claw back from — it opened a band for a
  // pair — so its refund is recorded and announced, and the band stays open
  // (R6, `appstore-prime-time.ts`). Routed on Apple's own product id, not the
  // untrusted one above. Before this branch such a refund fell through to the
  // ticket ledger, found nothing and was acknowledged without a trace.
  // A Date Wishlist sheet: the refund closes that viewer's sheet (2026-10-08).
  if (isWishlistProduct(lookup.transaction.productId)) {
    const wishlist = await refundWishlistAppStoreTransaction(lookup.transaction);
    console.log(
      `[appstore-webhook] wishlist ${notificationType} tx=${transactionId} -> ${wishlist.status}`,
    );
    res.json({ ok: true, result: wishlist.status });
    return;
  }

  if (isPrimeTimeProduct(lookup.transaction.productId)) {
    const prime = await refundPrimeTimeAppStoreTransaction(lookup.transaction);
    console.log(
      `[appstore-webhook] prime-time ${notificationType} tx=${transactionId} -> ${prime.status}`,
    );
    res.json({ ok: true, result: prime.status });
    return;
  }

  const result = await refundAppStoreTransaction(lookup.transaction);
  console.log(
    `[appstore-webhook] ${notificationType} tx=${transactionId} -> ${result.status}`,
  );
  res.json({ ok: true, result: result.status });
});

/**
 * `REFUND_REVERSED`: give back what the matching refund took, routed on Apple's
 * own product id. Each handler is idempotent (Apple retries) and announces to
 * the founder itself; an unmatched transaction answers a status and the route
 * still acks 200, so Apple never retries it forever.
 */
async function reverseRefund(transaction: AppStoreTransaction): Promise<string> {
  if (isPremiumProduct(transaction.productId)) {
    return (await reverseAppStorePremiumRefund(transaction)).result.status;
  }
  if (isVenueChangeProduct(transaction.productId)) {
    return (await reverseVenueChangeAppStoreRefund(transaction)).status;
  }
  if (isPrimeTimeProduct(transaction.productId)) {
    return (await reversePrimeTimeAppStoreRefund(transaction)).status;
  }
  return (await reverseAppStoreTicketRefund(transaction)).status;
}
