import { Router, type Request, type Response } from "express";
import { env } from "../../config.js";
import {
  requestPhoneCode,
  verifyPhoneCode,
} from "../../services/phone-verification.js";
import { findOrCreateMobileUserByPhone } from "../mobile-user.js";
import {
  accessTokenTtlSeconds,
  createRefreshToken,
  signAccessToken,
} from "../jwt.js";
import { phoneOtpRequestLimiter, phoneOtpVerifyLimiter } from "../rate-limit.js";
import { serializeUser } from "./serializers.js";

/**
 * Native-app phone rail (Registration v2 general track on iOS/Android).
 * Provider fork lives in `services/phone-verification.ts` — Telegram Gateway
 * primary, Twilio Verify SMS fallback; the client only sees `deliveredVia`.
 *
 * Gated by `PHONE_AUTH_ENABLED` (404 while off), mirroring the Mini App's
 * `/v1/telegram-onboarding/track` behavior for the same feature flag.
 */
export const phoneAuthRouter: Router = Router();

phoneAuthRouter.use((_req: Request, res: Response, next): void => {
  if (!env.PHONE_AUTH_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

phoneAuthRouter.post(
  "/request",
  phoneOtpRequestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const channel = typeof req.body?.channel === "string" ? req.body.channel : "";
    if (!phone) {
      res.status(400).json({ error: "Missing phone" });
      return;
    }
    if (channel && channel !== "sms") {
      res.status(400).json({ error: "Invalid channel" });
      return;
    }

    const result = await requestPhoneCode(phone, { forceSms: channel === "sms" });
    if (!result.ok) {
      switch (result.reason) {
        case "invalid_phone":
          res.status(400).json({ error: "Invalid phone number" });
          return;
        case "cooldown":
          res.status(429).json({
            error: "Code already sent, wait before retrying",
            resendAvailableAt: result.resendAvailableAt.toISOString(),
          });
          return;
        case "daily_cap":
          res.status(429).json({ error: "Daily code limit reached for this number" });
          return;
        case "unavailable":
          res.status(503).json({ error: "Code delivery unavailable, try again later" });
          return;
      }
    }

    res.json({
      ok: true,
      deliveredVia: result.deliveredVia,
      expiresAt: result.expiresAt.toISOString(),
      resendAvailableAt: result.resendAvailableAt.toISOString(),
    });
  },
);

phoneAuthRouter.post(
  "/verify",
  phoneOtpVerifyLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!phone || !/^\d{4,8}$/.test(code)) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }

    const result = await verifyPhoneCode(phone, code);
    if (!result.ok) {
      const status =
        result.reason === "mismatch"
          ? 401
          : result.reason === "provider_unavailable"
            ? 502
            : 400;
      res.status(status).json({ error: result.reason });
      return;
    }

    const user = await findOrCreateMobileUserByPhone(result.phone);
    const accessToken = signAccessToken(user.id);
    const refreshToken = await createRefreshToken(user.id, req.headers["user-agent"] ?? null);

    res.json({
      accessToken,
      refreshToken,
      expiresIn: accessTokenTtlSeconds(),
      user: serializeUser(user),
    });
  },
);
