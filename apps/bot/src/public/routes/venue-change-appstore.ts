import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";

import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { appStoreConfigured, decodeJwsPayload } from "../../services/appstore.js";
import { purchaseVenueChange } from "../../services/appstore-venue-change.js";

/**
 * StoreKit 2 purchase reporting for a venue change (native app only).
 *
 * JWT auth — unlike the board's own router, which takes either rail — because
 * there is nothing dual about this one: the Mini App pays in Stars and never
 * reaches here. Mounted on the more specific `/v1/venue-change/appstore` prefix
 * BEFORE `/v1/venue-change`, exactly as `/v1/tickets/appstore` is.
 *
 * Flow: the app buys the consumable → POSTs `{ jws, matchId }` → we decode the
 * JWS only to lift the transaction id (untrusted) → verify authoritatively via
 * the App Store Server API → settle that match's agreed change exactly-once →
 * the app calls `transaction.finish()` only after a 2xx, so an unreported
 * purchase is re-sent on the next launch.
 *
 * **409 is the one answer worth reading twice.** It means the money was taken
 * and the change could not be applied — the partner settled, or the session
 * lapsed, in the moment between. The purchase is parked for a manual refund
 * and the founder is alerted.
 *
 * The client should `finish()` on a 409 like it does on a 2xx, and say plainly
 * that the change could not be applied and the purchase will be refunded.
 * Re-reporting cannot help: the durable row already exists and the report is
 * idempotent, so a retry would return the same 409 forever while Apple keeps
 * re-delivering an unfinished transaction. What a 409 needs is a human, and it
 * already has one.
 */
export function createVenueChangeAppStoreRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next): void => {
    if (!env.VENUE_CHANGE_FEATURE_ENABLED) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  });
  router.use(requireAuth);

  const JWS_MAX_LENGTH = 20_000;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  router.post("/transaction", async (req: Request, res: Response): Promise<void> => {
    if (!appStoreConfigured()) {
      res.status(503).json({ error: "App Store verification not configured" });
      return;
    }
    const jws = typeof req.body?.jws === "string" ? req.body.jws.trim() : "";
    if (!jws || jws.length > JWS_MAX_LENGTH) {
      res.status(400).json({ error: "Missing jws" });
      return;
    }
    const matchId = typeof req.body?.matchId === "string" ? req.body.matchId : "";
    if (!UUID_REGEX.test(matchId)) {
      res.status(400).json({ error: "Missing matchId" });
      return;
    }

    const payload = decodeJwsPayload(jws);
    const transactionId =
      payload && typeof payload.transactionId === "string" ? payload.transactionId : "";
    if (!transactionId) {
      res.status(400).json({ error: "Invalid transaction payload" });
      return;
    }

    const result = await purchaseVenueChange(api, req.userId!, matchId, transactionId);
    switch (result.status) {
      case "settled":
      case "already_processed":
        res.json({ ok: true });
        return;
      case "invalid":
        res.status(422).json({ error: "Transaction rejected", code: result.reason });
        return;
      case "unclaimed":
        res.status(409).json({ error: "Change no longer available", code: result.reason });
        return;
      case "unavailable":
        res.status(503).json({ error: "App Store verification unavailable, retry" });
        return;
    }
  });

  return router;
}
