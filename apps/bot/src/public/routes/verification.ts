import { Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth } from "../auth-middleware.js";
import {
  beginLivenessCheck,
  completeLivenessCheck,
} from "../../services/liveness-flow.js";
import { getBotApi } from "../server.js";

/**
 * Native-client identity verification (AWS Rekognition Face Liveness).
 *
 * JWT twin of the Telegram Mini App router: same two steps, same trust
 * boundary, different auth. The iOS client runs Amplify's
 * `FaceLivenessDetectorView(sessionID:region:credentialsProvider:)` with what
 * `/native-init` returns.
 *
 * The Persona hosted-URL endpoint (`GET /v1/me/verification/url`) is gone with
 * the provider — there is no hosted page to send anyone to, and the native SDK
 * needs a session, not a URL.
 */

export const verificationRouter: Router = Router();

verificationRouter.use(requireAuth);

/** Session mint — 10/min/user. A liveness session is cheap but not free. */
const initLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req): string =>
    `liveness-init:${req.userId ?? ipKeyGenerator(req.ip ?? "") ?? "anon"}`,
  message: { error: "Too many verification requests, slow down." },
});

/**
 * GET /v1/me/verification/native-init — mint a Face Liveness session plus the
 * short-lived, single-action AWS credentials the on-device component uses to
 * stream its video. Flips `verificationStatus` to `pending`.
 */
verificationRouter.get(
  "/native-init",
  initLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const begun = await beginLivenessCheck(req.userId!);
    if (!begun.ok) {
      switch (begun.error) {
        case "user_not_found":
          res.status(404).json({ error: "User not found" });
          return;
        case "already_verified":
          res.status(409).json({ error: "Already verified" });
          return;
        case "not_configured":
          res.status(503).json({ error: "Verification feature not configured" });
          return;
        default:
          res.status(503).json({ error: "Verification provider unavailable" });
          return;
      }
    }

    res.json({
      sessionId: begun.sessionId,
      region: begun.region,
      credentials: begun.credentials,
      language: begun.language,
    });
  },
);

/**
 * POST /v1/me/verification/native-event — the detector finished.
 *
 * `complete` reads AWS's verdict in-request (the session expires 3 minutes
 * after `native-init`, so there is no later chance) and starts the face-match
 * pipeline on a pass. `cancel`/`error` are logged only. The response's
 * `outcome` tells the app whether to show "checking your photos" or "try
 * again"; the terminal result arrives via push / `GET /v1/me/verification`.
 */
verificationRouter.post(
  "/native-event",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as
      | {
          kind?: unknown;
          sessionId?: unknown;
          message?: unknown;
          detail?: unknown;
        }
      | undefined;
    const kind = body?.kind;
    const sessionId =
      typeof body?.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId.slice(0, 64)
        : null;
    const message = typeof body?.message === "string" ? body.message.slice(0, 512) : null;
    const detail = typeof body?.detail === "string" ? body.detail.slice(0, 2000) : null;

    if (kind !== "complete" && kind !== "cancel" && kind !== "error") {
      res.status(400).json({ error: "invalid-kind" });
      return;
    }

    const userId = req.userId!;

    if (kind === "cancel" || kind === "error") {
      console.warn(`[verification] native detector ${kind}`, {
        userId,
        state: message,
        detail,
      });
      res.json({ ok: true });
      return;
    }

    if (!sessionId) {
      res.status(400).json({ error: "missing-session-id" });
      return;
    }

    // The pipeline needs the bot API (Telegram-hosted profile photos, outcome
    // DMs). During a boot race it may not exist yet — better to fail this
    // request, which the user can simply re-run, than to consume a passing
    // liveness check we cannot act on.
    const api = getBotApi();
    if (!api) {
      res.status(503).json({ error: "Verification temporarily unavailable" });
      return;
    }

    const completed = await completeLivenessCheck(userId, sessionId, api);
    if (!completed.ok) {
      res
        .status(completed.error === "user_not_found" ? 404 : 503)
        .json({ error: completed.error.replace(/_/g, "-") });
      return;
    }

    res.json({ ok: true, outcome: completed.outcome });
  },
);
