import { Router, type Request, type Response } from "express";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import {
  appStoreConfigured,
  decodeJwsPayload,
  getVerifiedTransaction,
} from "../../services/appstore.js";
import { applyAppStorePremium } from "../../services/appstore-premium.js";

/**
 * StoreKit 2 Gennety Premium subscription reporting for the native app (JWT
 * auth — the App Store twin of the Telegram Stars `/v1/premium/stars-invoice`
 * flow). Mounted on `/v1/premium/appstore`, BEFORE the initData-authed
 * `/v1/premium` Mini App router so this more-specific prefix wins.
 *
 * Flow: the app buys/renews the auto-renewable subscription → POSTs the
 * transaction `jwsRepresentation` here → we extract the transactionId (decode
 * only — untrusted) → verify authoritatively via the App Store Server API →
 * activate/extend the entitlement to Apple's `expiresDate`. Renewals also arrive
 * via the Server Notification webhook, so this endpoint is idempotent.
 */
export const premiumAppStoreRouter: Router = Router();

premiumAppStoreRouter.use((_req: Request, res: Response, next): void => {
  if (!env.PREMIUM_FEATURE_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});
premiumAppStoreRouter.use(requireAuth);

const JWS_MAX_LENGTH = 20_000;

premiumAppStoreRouter.post(
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

    const lookup = await getVerifiedTransaction(transactionId);
    if (lookup.status === "unavailable") {
      res.status(503).json({ error: "App Store verification unavailable, retry" });
      return;
    }
    if (lookup.status === "not_found") {
      res.status(422).json({ error: "Transaction rejected", code: "unknown_transaction" });
      return;
    }

    const result = await applyAppStorePremium(req.userId!, lookup.transaction);
    switch (result.status) {
      case "activated":
        res.json({ ok: true, active: true, premiumUntil: result.premiumUntil });
        return;
      case "already_processed":
        res.json({ ok: true, active: true });
        return;
      case "revoked":
        res.json({ ok: true, active: false });
        return;
      case "invalid":
        res.status(422).json({ error: "Transaction rejected", code: result.reason });
        return;
    }
  },
);
