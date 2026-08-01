import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { prisma } from "@gennety/db";
import { LEGAL_DOCS_VERSION, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import {
  beginLivenessCheck,
  completeLivenessCheck,
  recordBiometricConsent,
} from "../../services/liveness-flow.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { verifyAnalysisSteps } from "../../services/analysis-status.js";

/**
 * Verification Mini App endpoints (AWS Rekognition Face Liveness).
 *
 *   GET  /v1/verification/mini-app/init   — mint a liveness session plus the
 *                                           short-lived AWS credentials the
 *                                           on-device Amplify component uses
 *                                           to stream its selfie video.
 *                                           Side-effect: `verificationStatus`
 *                                           → `pending`.
 *
 *   POST /v1/verification/mini-app/event  — terminal event from the detector.
 *                                           `complete` reads the AWS verdict
 *                                           SYNCHRONOUSLY and kicks off the
 *                                           face-match pipeline on a pass;
 *                                           `cancel`/`error` are logged.
 *
 * Why `complete` cannot be deferred: a Face Liveness session — and the
 * reference image it produced — expires 3 minutes after `/init`. There is no
 * webhook and no later re-fetch, so this request is the only chance to read
 * the result. (Under Persona this endpoint merely nudged an async pull.)
 *
 * Trust boundary: the client only reports "I finished". The verdict comes from
 * AWS via a server-to-server call, so a forged `complete` reads an unfinished
 * session and changes nothing.
 *
 * Auth: `Authorization: tma <initData>` — same convention as
 * /v1/calendar/* /v1/location/* /v1/feedback/*. Telegram-side HMAC, no JWT.
 */

// 10/min/user — cheap but defensive against a Mini App that hot-retries
// /init in a loop. Created at module-import time (NOT inside the factory) —
// express-rate-limit's runtime validator (ERR_ERL_CREATED_IN_REQUEST_HANDLER)
// rejects limiters constructed inside request handlers, and server.ts
// lazy-instantiates this router on first request.
const initLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req): string => {
    const auth = req.header("authorization") ?? req.header("Authorization");
    if (auth?.startsWith("tma ")) {
      const init = auth.slice(4).trim();
      // Hash-y enough to bucket per-user without parsing initData here
      // (auth header is already capped at Telegram's initData size).
      return `verify-init:${init.slice(0, 96)}`;
    }
    return `verify-init:${ipKeyGenerator(req.ip ?? "") ?? "anon"}`;
  },
  message: { error: "Too many init requests, slow down." },
});

export function createVerificationMiniAppRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.get(
    "/init",
    initLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const auth = authenticate(req);
      if (!auth.ok) {
        res.status(401).json(auth.body);
        return;
      }

      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(auth.user.id) },
        select: { id: true },
      });
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }

      const begun = await beginLivenessCheck(user.id);
      if (!begun.ok) {
        res.status(statusForBeginError(begun.error)).json({
          error: begun.error.replace(/_/g, "-"),
        });
        return;
      }

      res.status(200).json({
        sessionId: begun.sessionId,
        region: begun.region,
        credentials: begun.credentials,
        language: begun.language,
      });
    },
  );

  /**
   * POST /v1/verification/mini-app/consent — the user tapped "I agree" on the
   * biometric-consent screen (GDPR Art. 9(2)(a)).
   *
   * A separate call rather than a flag on `/init` so the consent is recorded
   * as its own act, on its own screen, before anything is minted — and so a
   * failure to record it can refuse the session instead of silently running a
   * biometric check with no basis.
   */
  router.post(
    "/consent",
    initLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const auth = authenticate(req);
      if (!auth.ok) {
        res.status(401).json(auth.body);
        return;
      }

      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(auth.user.id) },
        select: { id: true },
      });
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }

      const recorded = await recordBiometricConsent(user.id, LEGAL_DOCS_VERSION);
      if (!recorded.ok) {
        res.status(503).json({ error: "consent-not-recorded" });
        return;
      }
      res.status(200).json({ ok: true });
    },
  );

  router.post(
    "/event",
    async (req: Request, res: Response): Promise<void> => {
      const auth = authenticate(req);
      if (!auth.ok) {
        res.status(401).json(auth.body);
        return;
      }

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
          ? body.sessionId.slice(0, 64) // cap defensively; AWS ids are 36 chars
          : null;
      const message =
        typeof body?.message === "string" ? body.message.slice(0, 512) : null;
      // The underlying exception + the WebView's media capabilities. Roomy on
      // purpose: `RUNTIME_ERROR` with no detail is undebuggable, and this is
      // the only channel through which a field failure can explain itself.
      const detail =
        typeof body?.detail === "string" ? body.detail.slice(0, 2000) : null;

      if (kind !== "complete" && kind !== "cancel" && kind !== "error") {
        res.status(400).json({ error: "invalid-kind" });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(auth.user.id) },
        select: { id: true, language: true },
      });
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }

      if (kind === "cancel") {
        console.warn("[verification-mini-app] user cancelled the liveness check", {
          userId: user.id,
        });
        res.status(200).json({ ok: true });
        return;
      }

      if (kind === "error") {
        console.error("[verification-mini-app] detector error", {
          userId: user.id,
          state: message,
          detail,
        });
        res.status(200).json({ ok: true });
        return;
      }

      // kind === "complete" — the session is already ~10-60s old and dies at
      // the 3-minute mark, so read the verdict before answering.
      if (!sessionId) {
        res.status(400).json({ error: "missing-session-id" });
        return;
      }

      const completed = await completeLivenessCheck(user.id, sessionId, api);
      if (!completed.ok) {
        // `session_mismatch` is a 409, not a 503: nothing is wrong with the
        // deploy, the reported session simply isn't this user's (a stale tab,
        // or a client reporting a session it doesn't own). The Mini App's
        // answer is to start a fresh check.
        const status =
          completed.error === "user_not_found"
            ? 404
            : completed.error === "session_mismatch"
              ? 409
              : 503;
        res.status(status).json({ error: completed.error.replace(/_/g, "-") });
        return;
      }

      // On a pass, narrate the face-match work that is now running in the
      // background. It deletes itself; the pipeline's DM is the source of
      // truth. On a retry the flow already DM'd the user, so stay quiet.
      if (completed.outcome === "processing") {
        void runStatusSequence(
          api,
          auth.user.id,
          verifyAnalysisSteps((user.language ?? "en") as Language),
          { rich: true },
        ).catch(() => {});
      }

      res.status(200).json({ ok: true, outcome: completed.outcome });
    },
  );

  return router;
}

/**
 * `already_verified` is a 409 so the Mini App can render its "you're verified"
 * screen; a half-configured deploy is a 503 rather than a silent empty session.
 */
function statusForBeginError(
  error:
    | "not_configured"
    | "user_not_found"
    | "already_verified"
    | "consent_required"
    | "provider",
): number {
  switch (error) {
    case "user_not_found":
      return 404;
    case "already_verified":
    case "consent_required":
      return 409;
    default:
      return 503;
  }
}

type AuthOk = { ok: true; user: { id: number } };
type AuthErr = { ok: false; body: { error: string; reason?: string } };

function authenticate(req: Request): AuthOk | AuthErr {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, body: { error: "Missing tma initData" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) {
    return { ok: false, body: { error: "Empty initData" } };
  }
  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return {
      ok: false,
      body: { error: "Invalid initData", reason: validation.reason },
    };
  }
  return { ok: true, user: { id: validation.user.id } };
}
