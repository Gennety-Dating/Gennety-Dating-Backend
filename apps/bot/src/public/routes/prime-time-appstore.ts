import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";

import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { appStoreConfigured, decodeJwsPayload } from "../../services/appstore.js";
import { purchasePrimeTimePass } from "../../services/appstore-prime-time.js";
import { primeTimeFeatureLive } from "../../services/prime-time.js";

/**
 * StoreKit 2 purchase reporting for the Prime Time pass (native app only, M7).
 *
 * `POST /v1/prime-time/appstore/transaction` with `{ jws, matchId }`, JWT auth —
 * the same shape as every other App Store till (`/v1/<domain>/appstore/…`).
 * Deliberately NOT under `/v1/calendar`: that prefix is the Mini App's
 * `initData` router, which a native app has nothing to authenticate with.
 *
 * Flow: the app re-reads the calendar and only buys while the band is still
 * locked → buys the consumable → POSTs the JWS here → we lift the transaction
 * id (untrusted), verify it with Apple, and open the band for the PAIR once →
 * the app finishes the transaction on a final answer only.
 *
 * **409 means the money was taken and the pass was not applied** — the partner
 * opened the band, the pair locked a date, or the buyer is not in this match.
 * Parked for a manual refund with a founder alert. The client finishes the
 * transaction (a retry returns the same 409 forever) and promises a manual
 * refund; it never says the band was bought.
 */
export function createPrimeTimeAppStoreRouter(api: Api<RawApi>): Router {
  const router = Router();

  // 404 while the rail is off: the route does not exist, which is also what
  // tells an older or newer build not to offer a purchase this server will not
  // take. The keys are checked separately below (503), like every other till.
  router.use((_req: Request, res: Response, next): void => {
    if (!primeTimeFeatureLive() || !env.PRIME_TIME_APPSTORE_ENABLED) {
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

    const result = await purchasePrimeTimePass(api, req.userId!, matchId, transactionId);
    switch (result.status) {
      case "settled":
        res.json({ ok: true });
        return;
      case "invalid":
        res.status(422).json({ error: "Transaction rejected", code: result.reason });
        return;
      case "unclaimed":
        res
          .status(409)
          .json({ error: "Pass not applied — refund pending", code: result.reason });
        return;
      case "unavailable":
        res.status(503).json({ error: "App Store verification unavailable, retry" });
        return;
    }
  });

  return router;
}
