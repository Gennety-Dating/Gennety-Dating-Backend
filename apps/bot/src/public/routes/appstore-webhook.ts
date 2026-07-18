import { Router, type Request, type Response } from "express";
import {
  appStoreConfigured,
  decodeJwsPayload,
  getVerifiedTransaction,
} from "../../services/appstore.js";
import { refundAppStoreTransaction } from "../../services/appstore-tickets.js";

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

  if (!REFUND_NOTIFICATION_TYPES.has(notificationType)) {
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

  const result = await refundAppStoreTransaction(lookup.transaction);
  console.log(
    `[appstore-webhook] ${notificationType} tx=${transactionId} -> ${result.status}`,
  );
  res.json({ ok: true, result: result.status });
});
