import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { buildPersonaHostedUrl } from "../../services/persona.js";

export const verificationRouter: Router = Router();

verificationRouter.use(requireAuth);

/** Persona hosted-URL mint — 10/min/user. Cheap but not free if mobile hot-retries. */
const urlLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req): string => `persona-url:${req.userId ?? req.ip ?? "anon"}`,
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
