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
      await createAndSendOtp(email);
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
