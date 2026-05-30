import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { pullVerificationStatus } from "../../services/verification-pipeline.js";

/**
 * Verification Mini App endpoints (Phase 6.3 — Persona embedded flow).
 *
 *   GET  /v1/verification/mini-app/init    — return SDK config so the Mini
 *                                            App can mount Persona's
 *                                            embedded flow inline (no
 *                                            redirect to withpersona.com).
 *                                            Side-effect: flips
 *                                            `verificationStatus` to
 *                                            `pending` so UI elsewhere can
 *                                            surface "review in progress"
 *                                            even if the webhook beats this
 *                                            response.
 *
 *   POST /v1/verification/mini-app/event   — terminal event from Persona's
 *                                            SDK callback. `complete`
 *                                            triggers a pull-fallback so
 *                                            the bot DM lands even when
 *                                            the HMAC webhook is delayed;
 *                                            `cancel`/`error` are best-
 *                                            effort logs (status stays
 *                                            `pending`, the poller dojuet).
 *
 * Trust boundary:
 *   The HMAC-signed Persona webhook (routes/persona-webhook.ts) remains the
 *   ONLY channel that writes `verified` / `rejected` to `verificationStatus`.
 *   This router can only flip the status to `pending` (in /init) and trigger
 *   the existing pull-fallback pipeline — which itself ONLY proceeds when
 *   Persona's REST API says the inquiry is `approved` (a server-to-server
 *   trust hop, not a client claim).
 *
 * Auth: `Authorization: tma <initData>` — same convention as
 * /v1/calendar/* /v1/location/* /v1/feedback/*. Telegram-side HMAC, no JWT.
 *
 * Companion mobile-side route `/v1/me/verification/url` (Bearer JWT) stays
 * for the Expo client, which can't host the Telegram WebView and still
 * needs the hosted-URL fallback.
 */

// 10/min/user — cheap but defensive against a Mini App that hot-retries
// /init in a loop. Mirrors the rate limit on /v1/me/verification/url. Created
// at module-import time (NOT inside the factory) — express-rate-limit's
// runtime validator (ERR_ERL_CREATED_IN_REQUEST_HANDLER) rejects limiters
// constructed inside request handlers, and server.ts lazy-instantiates this
// router on first request.
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

      // Defensive: a half-configured deploy should fail loudly, not silently
      // open a Persona iframe with empty IDs. Same gate the bot CTA uses.
      if (
        !env.ENABLE_PERSONA_VERIFICATION ||
        !env.PERSONA_TEMPLATE_ID ||
        !env.PERSONA_ENVIRONMENT_ID
      ) {
        res.status(503).json({ error: "Verification feature not configured" });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(auth.user.id) },
        select: { id: true, language: true, verificationStatus: true },
      });
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }

      // Already-verified short-circuit. The Mini App will render an
      // "you're verified" screen rather than mounting Persona again,
      // which would otherwise spin up a brand new inquiry against an
      // approved reference id.
      if (user.verificationStatus === "verified") {
        res.status(409).json({ error: "already-verified" });
        return;
      }

      // Flip to `pending` so the rest of the bot can surface "review in
      // progress" without waiting for the first Persona event. If the
      // user closes the Mini App before submitting, the status correctly
      // stays at `pending` — matching Persona's own semantics for an
      // inquiry that was started but not completed.
      await prisma.user
        .update({
          where: { id: user.id },
          data: { verificationStatus: "pending" },
        })
        .catch((err) => {
          // Best-effort — losing this write doesn't block verification.
          // The webhook/poller will still flip the status on terminal events.
          console.warn(
            `[verification-mini-app] failed to mark pending for ${user.id}:`,
            err,
          );
        });

      const language: Language = user.language ?? "en";

      // No `environment` field returned: Persona Embedded SDK v5 routes
      // purely on `environmentId` (the `env_xxxxx` id encodes which Persona
      // environment to hit). The legacy `environment: "sandbox" | "production"`
      // option is deprecated in v5 per Persona's parameters reference, so
      // passing it would be dead weight (and a source of misconfiguration —
      // env id and env string could drift).
      res.status(200).json({
        referenceId: user.id,
        templateId: env.PERSONA_TEMPLATE_ID,
        environmentId: env.PERSONA_ENVIRONMENT_ID,
        language,
      });
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
            inquiryId?: unknown;
            status?: unknown;
            message?: unknown;
          }
        | undefined;
      const kind = body?.kind;
      const inquiryId =
        typeof body?.inquiryId === "string" && body.inquiryId.length > 0
          ? body.inquiryId.slice(0, 128) // cap defensively
          : null;
      const status =
        typeof body?.status === "string" ? body.status.slice(0, 64) : null;
      const message =
        typeof body?.message === "string" ? body.message.slice(0, 512) : null;

      if (kind !== "complete" && kind !== "cancel" && kind !== "error") {
        res.status(400).json({ error: "invalid-kind" });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(auth.user.id) },
        select: { id: true, personaInquiryId: true },
      });
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }

      if (kind === "cancel") {
        console.warn("[verification-mini-app] user cancelled embedded flow", {
          userId: user.id,
        });
        res.status(200).json({ ok: true });
        return;
      }

      if (kind === "error") {
        console.error("[verification-mini-app] SDK error", {
          userId: user.id,
          message,
        });
        res.status(200).json({ ok: true });
        return;
      }

      // kind === "complete"
      if (inquiryId && user.personaInquiryId === null) {
        // Idempotent CAS on null — a concurrent webhook that already set
        // personaInquiryId wins and we leave it alone. The pipeline keys
        // its idempotency on personaInquiryId anyway, so a momentary race
        // doesn't double-run anything.
        const updated = await prisma.user.updateMany({
          where: { id: user.id, personaInquiryId: null },
          data: { personaInquiryId: inquiryId },
        });
        if (updated.count === 0) {
          console.warn(
            "[verification-mini-app] personaInquiryId already set, skipping write",
            { userId: user.id, inquiryId },
          );
        }
      }

      // Fire-and-forget the pull-fallback. If Persona's webhook already
      // landed, pullVerificationStatus short-circuits on the terminal
      // status; if not, it asks Persona's REST API directly and runs
      // the face-match pipeline when `approved`. The pipeline itself
      // delivers the outcome DM, so we don't have to here.
      void pullVerificationStatus(user.id, api).catch((err) => {
        console.error("[verification-mini-app] pullVerificationStatus threw", {
          userId: user.id,
          inquiryId,
          status,
          err,
        });
      });

      res.status(200).json({ ok: true });
    },
  );

  return router;
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
