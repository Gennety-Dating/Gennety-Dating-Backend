import { Router, type Request, type Response } from "express";
import { isUniversityEmail, SUPPORTED_LANGUAGES } from "@gennety/shared";
import type { Language, WebRegistrationPurpose } from "@gennety/db";
import { env } from "../../config.js";
import { createAndSendOtp, verifyOtp } from "../otp.js";
import { otpRequestLimiter, otpVerifyLimiter } from "../rate-limit.js";
import { createWebRegistrationLink } from "../../services/web-registration.js";

export const webRegistrationRouter: Router = Router();

const VALID_LANGUAGES = new Set<string>(SUPPORTED_LANGUAGES);
const VALID_PURPOSES = new Set<WebRegistrationPurpose>(["join", "login"]);

function bodyString(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value.trim() : "";
}

webRegistrationRouter.post(
  "/otp/request",
  otpRequestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const email = bodyString(req, "email").toLowerCase();
    if (!email || !isUniversityEmail(email)) {
      res.status(400).json({ error: "Invalid university email" });
      return;
    }

    try {
      await createAndSendOtp(email);
      res.json({ ok: true });
    } catch (err) {
      console.error("[web-registration] otp/request failed:", err);
      res.status(502).json({ error: "Failed to send OTP email" });
    }
  },
);

webRegistrationRouter.post(
  "/complete",
  otpVerifyLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!env.BOT_USERNAME) {
      res.status(503).json({ error: "Telegram bot is not configured" });
      return;
    }

    const email = bodyString(req, "email").toLowerCase();
    const otp = bodyString(req, "otp");
    const languageCandidate = bodyString(req, "language") || "en";
    const purposeCandidate = bodyString(req, "purpose") || "join";
    const termsAccepted = (req.body as Record<string, unknown> | undefined)?.termsAccepted;
    const researchOptIn =
      (req.body as Record<string, unknown> | undefined)?.researchOptIn ?? false;

    if (!email || !isUniversityEmail(email) || !/^\d{4,8}$/.test(otp)) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }
    if (!VALID_LANGUAGES.has(languageCandidate)) {
      res.status(400).json({ error: "Invalid language" });
      return;
    }
    if (!VALID_PURPOSES.has(purposeCandidate as WebRegistrationPurpose)) {
      res.status(400).json({ error: "Invalid purpose" });
      return;
    }
    if (termsAccepted !== true) {
      res.status(400).json({ error: "Terms must be accepted" });
      return;
    }
    if (typeof researchOptIn !== "boolean") {
      res.status(400).json({ error: "Invalid researchOptIn" });
      return;
    }

    const result = await verifyOtp(email, otp);
    if (!result.ok) {
      const status = result.reason === "mismatch" ? 401 : 400;
      res.status(status).json({ error: result.reason });
      return;
    }

    try {
      const link = await createWebRegistrationLink({
        email,
        language: languageCandidate as Language,
        purpose: purposeCandidate as WebRegistrationPurpose,
        termsAccepted: true,
        researchOptIn,
      });

      res.json({
        ok: true,
        telegramUrl: `https://t.me/${env.BOT_USERNAME}?start=${link.startParam}`,
        expiresAt: link.expiresAt.toISOString(),
      });
    } catch (err) {
      console.error("[web-registration] complete failed:", err);
      res.status(500).json({ error: "Failed to create Telegram handoff" });
    }
  },
);
