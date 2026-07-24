import { Router, type Request, type Response } from "express";
import { env } from "../../config.js";

/**
 * GET /v1/app/config — pre-auth bootstrap for the native mobile client.
 *
 * Deliberately unauthenticated: the app must be able to learn "this build is
 * no longer supported" BEFORE it can log in, so the kill-switch works even
 * when stored tokens are stale. Returns only non-sensitive, client-facing
 * flags — never secrets or server-internal toggles.
 *
 * `minSupportedIosVersion` is the forced-update kill switch: a client whose
 * CFBundleShortVersionString compares lower (semver-style) must block usage
 * behind an "update the app" screen. `null` → no forced update (default).
 */
export const appConfigRouter: Router = Router();

appConfigRouter.get("/config", (_req: Request, res: Response) => {
  res.json({
    minSupportedIosVersion: env.IOS_MIN_SUPPORTED_APP_VERSION || null,
    features: {
      phoneAuth: env.PHONE_AUTH_ENABLED,
      tickets: env.TICKET_FEATURE_ENABLED,
      coordination: env.COORDINATION_FEATURE_ENABLED,
      premium: env.PREMIUM_FEATURE_ENABLED,
      referral: env.REFERRAL_FEATURE_ENABLED,
    },
    serverNow: new Date().toISOString(),
  });
});
