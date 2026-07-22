import express, { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import {
  PERSONA_SIGNATURE_HEADER,
  isTrustedPersonaEvent,
  mapPersonaStatusToInternal,
  verifyPersonaWebhookSignature,
  type PersonaWebhookPayload,
} from "../../services/persona.js";
import { runFaceMatchVerificationDefault } from "../../services/verification-pipeline.js";

/**
 * Persona webhook router.
 *
 * Mounted at `/v1/webhooks/persona` with `express.raw` so HMAC can run on
 * the exact bytes received. Parsed JSON (`express.json`) would re-serialise
 * with different whitespace and break the signature.
 *
 * Takes the bot `Api` instance so we can DM the user on a final verification
 * decision without reaching into the bot module from this layer.
 */
export function createPersonaWebhookRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.post(
    "/",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req: Request, res: Response): Promise<void> => {
      if (!env.PERSONA_WEBHOOK_SECRET) {
        res.status(503).json({ error: "Persona webhook not configured" });
        return;
      }

      const rawBody = req.body as Buffer;
      if (!Buffer.isBuffer(rawBody)) {
        res.status(400).json({ error: "Expected raw body" });
        return;
      }

      const signature = req.header(PERSONA_SIGNATURE_HEADER);
      const ok = verifyPersonaWebhookSignature(rawBody, signature, env.PERSONA_WEBHOOK_SECRET);
      if (!ok) {
        console.warn("[persona] webhook signature mismatch", {
          headerPresent: Boolean(signature),
        });
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      let payload: PersonaWebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as PersonaWebhookPayload;
      } catch {
        res.status(400).json({ error: "Invalid JSON" });
        return;
      }

      try {
        await handlePersonaEvent(api, payload);
      } catch (err) {
        console.error("[persona] handler error:", err);
        res.status(500).json({ error: "Persona handler failed" });
        return;
      }

      res.status(200).json({ ok: true });
    },
  );

  return router;
}

async function handlePersonaEvent(
  api: Api<RawApi>,
  payload: PersonaWebhookPayload,
): Promise<void> {
  const eventName = payload.data?.attributes?.name;
  const inquiry = payload.data?.attributes?.payload?.data;
  const inquiryId = inquiry?.id;
  const inquiryAttrs = inquiry?.attributes;
  const status = inquiryAttrs?.status;
  // Persona emits this field as camelCase `referenceId` in current webhooks;
  // older docs / early versions of this code expected kebab-case `reference-id`.
  // Read both so a future Persona schema flip doesn't silently break verification.
  const referenceId = inquiryAttrs?.referenceId ?? inquiryAttrs?.["reference-id"];

  if (!status || !referenceId) {
    console.warn("[persona] webhook missing status or reference-id", { eventName, inquiryId });
    return;
  }

  // M-9: only act on terminal-decision events. Persona fires dozens of
  // intermediate `inquiry.*` events through the flow (created, started,
  // transitioned, …); some carry `status: "approved"` as metadata without
  // meaning the user actually passed. Allowlisting prevents a `created`
  // event from prematurely activating someone.
  if (!isTrustedPersonaEvent(eventName)) {
    console.log("[persona] ignoring non-terminal event", { eventName, status });
    return;
  }

  // `reference-id` is the DB user.id we passed into the hosted URL.
  const user = await prisma.user.findUnique({
    where: { id: referenceId },
    select: {
      id: true,
      telegramId: true,
      language: true,
      verificationStatus: true,
      status: true,
      profile: {
        select: { id: true },
      },
    },
  });
  if (!user) {
    console.warn("[persona] unknown reference-id", { referenceId, eventName });
    return;
  }

  // Record the Persona inquiry id on first sighting — idempotent across retries.
  if (inquiryId) {
    await prisma.user
      .update({
        where: { id: user.id },
        data: { personaInquiryId: inquiryId },
      })
      .catch((err: unknown) => {
        // P2002 = unique violation (duplicate retry). Swallow; re-throw other errors.
        const code = (err as { code?: string } | undefined)?.code;
        if (code !== "P2002") throw err;
      });
  }

  const next = mapPersonaStatusToInternal(status);

  if (next === "verified") {
    // Defensive: a terminal approved event should always carry the inquiry id.
    // If one ever arrives without it, refuse to run the pipeline with `""` —
    // `persistOutcome` writes `personaInquiryId` unconditionally, so an empty
    // id would clobber a valid one and break every later Persona re-fetch
    // (selfie retention, photo-edit reruns → 404). The next well-formed event
    // (or the pull-fallback) resolves the user cleanly.
    if (!inquiryId) {
      console.warn("[persona] verified event missing inquiry id — skipping pipeline", {
        eventName,
        referenceId,
      });
      return;
    }

    // Liveness passed at Persona — but DON'T flip to `verified` yet. The
    // face-match pipeline still has to confirm the photos in this profile
    // belong to the same person Persona just put in front of the camera.
    // The pipeline writes the final state (`verified` / `pending_review`
    // / `rejected`) and DMs the user with the outcome.
    //
    // Webhook-side responsibility:
    //   1. Hold `verificationStatus = pending` (already the case from
    //      `sendVerificationCTA` — kept defensively in case the user
    //      somehow re-enters with a different prior state).
    //   2. Fire the pipeline asynchronously via `setImmediate` so
    //      Persona gets its 200 OK *before* we start a multi-second
    //      Rekognition + S3 dance. Persona retries aggressively on slow
    //      responses; a foreground pipeline call would invite duplicates.
    //
    // The pipeline is internally idempotent — keyed on `inquiryId` — so
    // a webhook retry that lands during pipeline execution is harmless.
    await prisma.user
      .update({
        where: { id: user.id },
        data: { verificationStatus: "pending" },
      })
      .catch((err: unknown) => {
        console.warn("[persona] pending status update failed:", err);
      });

    setImmediate(() => {
      runFaceMatchVerificationDefault(user.id, inquiryId, api).catch((err: unknown) => {
        // Catch-all so an unhandled rejection doesn't crash the process.
        // The pipeline already persists pending_review on every internal
        // error path; this log catches truly unexpected exceptions
        // (Prisma connection lost, OOM, …).
        console.error("[persona] verification pipeline crashed:", err);
      });
    });
    return;
  }

  if (next === "rejected") {
    await prisma.user.update({
      where: { id: user.id },
      data: { verificationStatus: "rejected" },
    });
    if (user.telegramId > 0n) {
      const lang = (user.language ?? "en") as Language;
      await api
        .sendMessage(Number(user.telegramId), t(lang, "verifyAutoPollPersonaFailed"))
        .catch(() => {});
    }
    return;
  }

  // pending — Persona still working on the inquiry. No-op; the status column
  // stays as-is (most likely `pending` already, set when we minted the URL).
}
