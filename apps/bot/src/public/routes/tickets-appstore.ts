import { Router, type Request, type Response } from "express";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { appStoreConfigured, decodeJwsPayload } from "../../services/appstore.js";
import { creditAppStoreTransaction } from "../../services/appstore-tickets.js";

/**
 * StoreKit 2 purchase reporting for the native app (JWT auth — unlike the
 * Mini App's initData `/v1/tickets` router, so this mounts on the more
 * specific `/v1/tickets/appstore` prefix BEFORE it).
 *
 * Flow: the app buys a consumable → POSTs `transaction.jwsRepresentation`
 * here → we extract the transactionId (decode only — untrusted) → verify
 * authoritatively via the App Store Server API → credit the wallet
 * exactly-once → the app calls `transaction.finish()` only after a 2xx, so
 * an unprocessed purchase is re-reported on next launch.
 */
export const ticketsAppStoreRouter: Router = Router();

ticketsAppStoreRouter.use((_req: Request, res: Response, next): void => {
  if (!env.TICKET_FEATURE_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});
ticketsAppStoreRouter.use(requireAuth);

const JWS_MAX_LENGTH = 20_000;

ticketsAppStoreRouter.post(
  "/transaction",
  async (req: Request, res: Response): Promise<void> => {
    if (!appStoreConfigured()) {
      res.status(503).json({ error: "App Store verification not configured" });
      return;
    }
    const jws = typeof req.body?.jws === "string" ? req.body.jws.trim() : "";
    if (!jws || jws.length > JWS_MAX_LENGTH) {
      res.status(400).json({ error: "Missing jws" });
      return;
    }

    const payload = decodeJwsPayload(jws);
    const transactionId =
      payload && typeof payload.transactionId === "string" ? payload.transactionId : "";
    if (!transactionId) {
      res.status(400).json({ error: "Invalid transaction payload" });
      return;
    }

    const result = await creditAppStoreTransaction(req.userId!, transactionId);
    switch (result.status) {
      case "credited":
        res.json({ ok: true, credited: result.credited, balance: result.balance });
        return;
      case "already_processed":
        res.json({ ok: true, credited: 0, balance: result.balance });
        return;
      case "invalid":
        res.status(422).json({ error: "Transaction rejected", code: result.reason });
        return;
      case "unavailable":
        res.status(503).json({ error: "App Store verification unavailable, retry" });
        return;
    }
  },
);
