import { Router, type Request, type Response } from "express";
import { isUniversityEmail } from "@gennety/shared";
import { createAndSendOtp, verifyOtp } from "../otp.js";
import { findOrCreateMobileUser } from "../mobile-user.js";
import {
  accessTokenTtlSeconds,
  createRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from "../jwt.js";
import { otpRequestLimiter, otpVerifyLimiter, refreshLimiter } from "../rate-limit.js";
import { requireAuth } from "../auth-middleware.js";
import { signOutDevice } from "../../services/device-tokens.js";
import { serializeUser } from "./serializers.js";

export const authRouter: Router = Router();

authRouter.post(
  "/otp/request",
  otpRequestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!email || !isUniversityEmail(email)) {
      res.status(400).json({ error: "Invalid university email" });
      return;
    }

    try {
      // The login rail: a `+tag` address is honoured only for an account that
      // already verified exactly that string, so nobody who signed up that way
      // is locked out, and nobody new can mint a second identity per tag.
      const result = await createAndSendOtp(email, { plusAlias: "existing_verified_only" });
      if (!result.ok) {
        if (result.reason === "plus_alias") {
          res.status(400).json({ error: "Email addresses with a '+' tag are not accepted" });
        } else {
          res.status(429).json({ error: "Too many codes requested for this email today" });
        }
        return;
      }
      // A cooldown hit (`sent: false`) still answers 200, as it always has: a
      // live code exists, and this rail never told the caller the difference.
      res.json({ ok: true });
    } catch (err) {
      console.error("[auth] otp/request failed:", err);
      res.status(502).json({ error: "Failed to send OTP email" });
    }
  },
);

authRouter.post(
  "/otp/verify",
  otpVerifyLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const otp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";

    if (!email || !isUniversityEmail(email) || !/^\d{4,8}$/.test(otp)) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }

    const result = await verifyOtp(email, otp);
    if (!result.ok) {
      const status = result.reason === "mismatch" ? 401 : 400;
      res.status(status).json({ error: result.reason });
      return;
    }

    const user = await findOrCreateMobileUser(email);
    const accessToken = signAccessToken(user.id);
    const userAgent = req.headers["user-agent"] ?? null;
    const refreshToken = await createRefreshToken(user.id, userAgent);

    res.json({
      accessToken,
      refreshToken,
      expiresIn: accessTokenTtlSeconds(),
      user: serializeUser(user),
    });
  },
);

authRouter.post(
  "/refresh",
  refreshLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const rawToken =
      typeof req.body?.refreshToken === "string" ? req.body.refreshToken.trim() : "";
    if (!rawToken) {
      res.status(400).json({ error: "Missing refreshToken" });
      return;
    }

    // A token whose account moderation has locked (suspended, under
    // investigation, banned) is refused inside the rotation itself, and every
    // session of that account is revoked with it — see `rotateRefreshToken`.
    const rotated = await rotateRefreshToken(rawToken, req.headers["user-agent"] ?? null);
    if (!rotated) {
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    const accessToken = signAccessToken(rotated.userId);
    res.json({
      accessToken,
      refreshToken: rotated.nextRefreshToken,
      expiresIn: accessTokenTtlSeconds(),
    });
  },
);

/**
 * POST /v1/auth/logout — sign this device out (audit A13-L12).
 *
 * There was no way to do it: an app that "logged out" only forgot its tokens
 * locally, while the server went on pushing the account's notifications to the
 * device and kept its 30-day refresh session alive. Clears the account's push
 * and Live Activity tokens and revokes the refresh session the body presents,
 * or every session when it presents none. Idempotent — signing out twice, or
 * with a session already rotated away, still answers `ok`.
 */
authRouter.post(
  "/logout",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const rawToken =
      typeof req.body?.refreshToken === "string" ? req.body.refreshToken.trim() : "";
    await signOutDevice(req.userId!, rawToken || null);
    res.json({ ok: true });
  },
);
