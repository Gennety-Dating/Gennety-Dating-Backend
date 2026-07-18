import { Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { buildPersonaHostedUrl } from "../../services/persona.js";
import { pullVerificationStatus } from "../../services/verification-pipeline.js";
import { getBotApi } from "../server.js";

export const verificationRouter: Router = Router();

verificationRouter.use(requireAuth);

/** Persona hosted-URL mint — 10/min/user. Cheap but not free if mobile hot-retries. */
const urlLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req): string =>
    `persona-url:${req.userId ?? ipKeyGenerator(req.ip ?? "") ?? "anon"}`,
  message: { error: "Too many verification URL requests, slow down." },
});

/**
 * GET /v1/me/verification/url
 *
 * Returns the Persona hosted-flow URL bound to the caller's user id. The
 * mobile app opens it in a webview; the Telegram bot opens it via an inline
 * `web_app` button (see `handlers/onboarding/verification.ts`).
 *
 * Persona's hosted flow is fully self-contained — no access token to mint.
 * The URL is safe to expose client-side because the template-id and
 * environment-id alone cannot be used to forge a completed verification;
 * only an HMAC-signed webhook from Persona flips `verificationStatus`.
 */
verificationRouter.get("/url", urlLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!env.PERSONA_TEMPLATE_ID || !env.PERSONA_ENVIRONMENT_ID) {
    res.status(503).json({ error: "Verification feature not configured" });
    return;
  }
  const userId = req.userId!;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, verificationStatus: true },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (user.verificationStatus === "verified") {
    res.status(409).json({ error: "Already verified" });
    return;
  }

  const url = buildPersonaHostedUrl(userId);

  // Mark pending so UI can surface "review in progress" without waiting for
  // the first webhook. If the user never completes the flow, the status stays
  // at `pending` — this is intentional (matches Persona's own semantics).
  await prisma.user.update({
    where: { id: userId },
    data: { verificationStatus: "pending" },
  });

  res.json({ url, referenceId: userId });
});

/**
 * GET /v1/me/verification/native-init — Persona Inquiry SDK config for the
 * native iOS client (IOS_APP_ROADMAP task 0.11). JWT twin of the Mini App's
 * `/v1/verification/mini-app/init`: same fields, same pending flip, same
 * trust boundary (only the HMAC webhook / pull-fallback pipeline can ever
 * write `verified`/`rejected`).
 */
verificationRouter.get(
  "/native-init",
  urlLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (
      !env.ENABLE_PERSONA_VERIFICATION ||
      !env.PERSONA_TEMPLATE_ID ||
      !env.PERSONA_ENVIRONMENT_ID
    ) {
      res.status(503).json({ error: "Verification feature not configured" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, language: true, verificationStatus: true },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (user.verificationStatus === "verified") {
      res.status(409).json({ error: "Already verified" });
      return;
    }

    await prisma.user
      .update({ where: { id: user.id }, data: { verificationStatus: "pending" } })
      .catch((err) => {
        console.warn(`[verification] failed to mark pending for ${user.id}:`, err);
      });

    const language: Language = user.language ?? "en";
    res.json({
      referenceId: user.id,
      templateId: env.PERSONA_TEMPLATE_ID,
      environmentId: env.PERSONA_ENVIRONMENT_ID,
      language,
    });
  },
);

/**
 * POST /v1/me/verification/native-event — terminal callback from the native
 * Persona SDK. `complete` CAS-writes `personaInquiryId` and fires the
 * pull-fallback pipeline (which itself trusts only Persona's REST answer);
 * `cancel`/`error` are logged. Never writes `verified`/`rejected` directly.
 */
verificationRouter.post(
  "/native-event",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as
      | { kind?: unknown; inquiryId?: unknown; message?: unknown }
      | undefined;
    const kind = body?.kind;
    const inquiryId =
      typeof body?.inquiryId === "string" && body.inquiryId.length > 0
        ? body.inquiryId.slice(0, 128)
        : null;
    const message = typeof body?.message === "string" ? body.message.slice(0, 512) : null;

    if (kind !== "complete" && kind !== "cancel" && kind !== "error") {
      res.status(400).json({ error: "invalid-kind" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, personaInquiryId: true },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (kind === "cancel" || kind === "error") {
      console.warn(`[verification] native SDK ${kind}`, { userId: user.id, message });
      res.json({ ok: true });
      return;
    }

    if (inquiryId && user.personaInquiryId === null) {
      const updated = await prisma.user.updateMany({
        where: { id: user.id, personaInquiryId: null },
        data: { personaInquiryId: inquiryId },
      });
      if (updated.count === 0) {
        console.warn("[verification] personaInquiryId already set, skipping write", {
          userId: user.id,
          inquiryId,
        });
      }
    }

    // Pull-fallback so the outcome lands even when the HMAC webhook is
    // delayed. Needs the bot Api for the pipeline's Telegram-side effects;
    // during boot races the webhook remains the guaranteed path.
    const api = getBotApi();
    if (api) {
      void pullVerificationStatus(user.id, api).catch((err) => {
        console.error("[verification] native pullVerificationStatus threw", {
          userId: user.id,
          inquiryId,
          err,
        });
      });
    }

    res.json({ ok: true });
  },
);
