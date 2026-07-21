import { Router, type Request, type Response } from "express";
import {
  appStoreConfigured,
  decodeJwsPayload,
  getVerifiedTransaction,
  isPremiumProduct,
} from "../../services/appstore.js";
import { refundAppStoreTransaction } from "../../services/appstore-tickets.js";
import {
  handleAppStorePremiumNotification,
  PREMIUM_RENEW_NOTIFICATIONS,
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

  if (!isPremium && !REFUND_NOTIFICATION_TYPES.has(notificationType)) {
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

  if (isPremium) {
    const premium = await handleAppStorePremiumNotification(lookup.transaction, notificationType);
    console.log(
      `[appstore-webhook] premium ${notificationType} tx=${transactionId} -> ${premium.status}`,
    );
    res.json({ ok: true, result: premium.status });
    return;
  }

  const result = await refundAppStoreTransaction(lookup.transaction);
  console.log(
    `[appstore-webhook] ${notificationType} tx=${transactionId} -> ${result.status}`,
  );
  res.json({ ok: true, result: result.status });
});
