import { Router, type Request, type Response } from "express";
import { isUniversityEmail, SUPPORTED_LANGUAGES } from "@gennety/shared";
import type { Language, WebRegistrationPurpose } from "@gennety/db";
import { env } from "../../config.js";
import { createAndSendOtp, verifyOtp } from "../otp.js";
import { otpRequestLimiter, otpVerifyLimiter, publicReadLimiter } from "../rate-limit.js";
import { createWebRegistrationLink } from "../../services/web-registration.js";
import { validateHomeLocationPayload } from "../home-location.js";
import { resolveCityFromCoordinates, searchCities } from "../city-search.js";

export const webRegistrationRouter: Router = Router();

const VALID_LANGUAGES = new Set<string>(SUPPORTED_LANGUAGES);
const VALID_PURPOSES = new Set<WebRegistrationPurpose>(["join", "login"]);
const VALID_TRACKS = new Set(["student", "general"]);

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

/**
 * City lookup for the website's student-track city gate. Unauthenticated by
 * necessity — the visitor has no account yet — so it is rate-limited and only
 * ever proxies a public Places search, keeping `PLACES_API_KEY` server-side.
 */
webRegistrationRouter.get(
  "/city/search",
  publicReadLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) {
      res.json({ ok: true, results: [] });
      return;
    }
    res.json({ ok: true, results: await searchCities(q) });
  },
);

/** Browser-geolocation → city, so the site offers the same one-tap as the Mini App. */
webRegistrationRouter.post(
  "/city/resolve",
  publicReadLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lat = typeof body.latitude === "number" ? body.latitude : null;
    const lng = typeof body.longitude === "number" ? body.longitude : null;
    if (
      lat === null ||
      lng === null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      res.status(400).json({ error: "invalid-coordinates" });
      return;
    }

    res.json({ ok: true, city: await resolveCityFromCoordinates(lat, lng) });
  },
);

/**
 * Mint the Telegram handoff link. The website owns language + consent + the
 * sign-up fork; what else it must supply depends on the track:
 *
 * - `student` — a university email it OTP-verified here, plus the dating city.
 *   Telegram then resumes at the theme picker.
 * - `general` — nothing else. The phone is deliberately NOT collected on the
 *   web: only Telegram's own `message.contact` is trusted, so the user lands on
 *   the Mini App's phone gate. The link merely records the *choice* of rail.
 */
webRegistrationRouter.post(
  "/complete",
  otpVerifyLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!env.BOT_USERNAME) {
      res.status(503).json({ error: "Telegram bot is not configured" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const languageCandidate = bodyString(req, "language") || "en";
    const purposeCandidate = bodyString(req, "purpose") || "join";
    // Links minted before the fork existed were all student links; keep that
    // default so an older website build keeps working through a deploy.
    const trackCandidate = bodyString(req, "track") || "student";
    const termsAccepted = body.termsAccepted;
    const researchOptIn = body.researchOptIn ?? false;

    if (!VALID_LANGUAGES.has(languageCandidate)) {
      res.status(400).json({ error: "Invalid language" });
      return;
    }
    if (!VALID_PURPOSES.has(purposeCandidate as WebRegistrationPurpose)) {
      res.status(400).json({ error: "Invalid purpose" });
      return;
    }
    if (!VALID_TRACKS.has(trackCandidate)) {
      res.status(400).json({ error: "Invalid track" });
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

    const language = languageCandidate as Language;
    const purpose = purposeCandidate as WebRegistrationPurpose;

    try {
      if (trackCandidate === "general") {
        // No email, no OTP, no phone — by design.
        const link = await createWebRegistrationLink({
          track: "general",
          language,
          purpose,
          termsAccepted: true,
          researchOptIn,
        });
        res.json({
          ok: true,
          telegramUrl: `https://t.me/${env.BOT_USERNAME}?start=${link.startParam}`,
          expiresAt: link.expiresAt.toISOString(),
        });
        return;
      }

      const email = bodyString(req, "email").toLowerCase();
      const otp = bodyString(req, "otp");
      if (!email || !isUniversityEmail(email) || !/^\d{4,8}$/.test(otp)) {
        res.status(400).json({ error: "Invalid payload" });
        return;
      }

      const city = validateHomeLocationPayload(body);
      if (!city.ok) {
        res.status(400).json({ error: city.error });
        return;
      }

      const verified = await verifyOtp(email, otp);
      if (!verified.ok) {
        res.status(verified.reason === "mismatch" ? 401 : 400).json({ error: verified.reason });
        return;
      }

      const link = await createWebRegistrationLink({
        track: "student",
        email,
        city: city.data,
        language,
        purpose,
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
