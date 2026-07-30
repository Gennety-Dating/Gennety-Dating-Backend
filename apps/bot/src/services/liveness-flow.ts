import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import {
  createLivenessSession,
  getLivenessResult,
  type LivenessRetryOutcome,
} from "./face-liveness.js";
import { mintLivenessCredentials, type LivenessCredentials } from "./liveness-credentials.js";
import { runFaceMatchVerificationDefault } from "./verification-pipeline.js";
import { buildVerificationKeyboard } from "./verification-keyboard.js";
import { livenessRetryMessage } from "./verification-messages.js";

/**
 * The identity-verification flow, shared by both client surfaces.
 *
 * The Telegram Mini App (`initData` auth) and the native iOS client (JWT auth)
 * run the *same* two steps against different auth middleware, so the steps
 * live here and the routes stay thin:
 *
 *   begin()    → mint a liveness session + the short-lived AWS credentials the
 *                on-device Amplify component needs to stream its video.
 *   complete() → read the result INSIDE this request (the session dies 3
 *                minutes after `begin`), then hand a passing reference selfie
 *                to the face-match pipeline.
 *
 * Trust boundary: the client tells us only "I finished". Whether that means
 * verified is decided server-side from AWS's own answer — a forged `complete`
 * gets an `in_progress` reading and nothing happens.
 */

const LOG_PREFIX = "[liveness-flow]";

export type BeginLivenessResult =
  | {
      ok: true;
      sessionId: string;
      region: string;
      credentials: LivenessCredentials;
      language: Language;
    }
  | {
      ok: false;
      /** 503 — the deploy is half-configured. */
      error: "not_configured";
    }
  | { ok: false; error: "user_not_found" } // 404
  | { ok: false; error: "already_verified" } // 409
  | { ok: false; error: "provider" }; // 503, transient

/**
 * What the client should show next.
 *   - `processing` — liveness passed; the face-match pipeline is running and
 *     will DM/push the real outcome. This is the only success path.
 *   - `retry`      — we could not confirm a live person. Nothing is lost and
 *     nothing is held against the user; they run a new session.
 */
export type CompleteLivenessOutcome = "processing" | "retry";

export type CompleteLivenessResult =
  | { ok: true; outcome: CompleteLivenessOutcome }
  /**
   * `session_mismatch` — the reported session is not the one this user minted.
   * Either a stale tab finishing after a newer `/init`, or a client reporting a
   * session it does not own. Neither is a verdict, so nothing is written.
   */
  | { ok: false; error: "user_not_found" | "provider" | "session_mismatch" };

/**
 * Step 1 — mint a session and the credentials that let the device stream to
 * Rekognition. Flips the user to `pending` so the rest of the product can
 * surface "verification in progress" without waiting for a result.
 */
export async function beginLivenessCheck(
  userId: string,
): Promise<BeginLivenessResult> {
  if (!env.FACE_LIVENESS_ENABLED || !env.LIVENESS_STS_ROLE_ARN) {
    return { ok: false, error: "not_configured" };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      language: true,
      verificationStatus: true,
      verifiedSelfiePath: true,
    },
  });
  if (!user) return { ok: false, error: "user_not_found" };
  // Re-running liveness on an already-verified user would burn a check and a
  // session for no decision; the client renders a "you're verified" screen.
  //
  // ONE exception, and it is the whole point of `reference_expired`
  // (PRODUCT_SPEC §1.4 rule 5): the 90-day scrub deleted the reference selfie,
  // AWS cannot re-issue it, and every surface that touches photos — the photo
  // manager, `POST /v1/me/photos`, Aether — answers "verify again to change
  // your photos". Refusing here made that instruction impossible to follow:
  // the user was told to re-verify by the only product that could refuse it.
  const referenceExpired = !user.verifiedSelfiePath;
  const alreadyVerified = user.verificationStatus === "verified";
  if (alreadyVerified && !referenceExpired) {
    return { ok: false, error: "already_verified" };
  }

  const session = await createLivenessSession();
  if (!session.ok) {
    console.error(`${LOG_PREFIX} could not create session`, {
      userId,
      error: session.error,
    });
    return {
      ok: false,
      error: session.error === "not_configured" ? "not_configured" : "provider",
    };
  }

  const credentials = await mintLivenessCredentials(userId);
  if (!credentials.ok) {
    return {
      ok: false,
      error: credentials.error === "not_configured" ? "not_configured" : "provider",
    };
  }

  // Bind the session to this user. Unlike the `pending` flip beside it, this
  // write is NOT best-effort in spirit — `complete()` refuses a session id that
  // does not match it, so losing the write means the user has to re-run. That
  // is the right failure direction: the alternative is accepting any session id
  // the client cares to send.
  await prisma.user
    .update({
      where: { id: user.id },
      data: {
        // A verified user re-running only because their reference expired keeps
        // `verified` throughout. Matching admits `verified` and nothing else
        // (§3.2), so flipping them to `pending` would drop a long-tenured user
        // out of the pool over a photo edit — exactly what
        // `triggerVerificationRerun` already refuses to do by bailing before
        // its own `pending` flip.
        ...(alreadyVerified ? {} : { verificationStatus: "pending" as const }),
        pendingLivenessSessionId: session.sessionId,
      },
    })
    .catch((err) => {
      console.warn(`${LOG_PREFIX} failed to mark pending`, { userId, err });
    });

  return {
    ok: true,
    sessionId: session.sessionId,
    // Must be the region the session was created in — the detector opens its
    // WebSocket against this value. Handing it AWS_REGION would fail every
    // check, since liveness lives in a different region (see config).
    region: env.FACE_LIVENESS_REGION,
    credentials: credentials.credentials,
    language: user.language ?? "en",
  };
}

/**
 * Step 2 — the device says it finished. Read the verdict now, while the
 * session still exists, and start face-matching on a pass.
 *
 * `api` is required even on the mobile path: the pipeline needs it to pull
 * Telegram-hosted profile photos, and there is no longer an asynchronous
 * webhook that could settle the check later. A caller that cannot supply it
 * (a boot race) should fail the request so the user simply re-runs.
 */
export async function completeLivenessCheck(
  userId: string,
  sessionId: string,
  api: Api<RawApi>,
): Promise<CompleteLivenessResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      telegramId: true,
      language: true,
      pendingLivenessSessionId: true,
    },
  });
  if (!user) return { ok: false, error: "user_not_found" };

  // The client only ever reports "I finished", and the verdict itself comes
  // from AWS — but the session id is client-supplied, so without this check a
  // caller could ask us to read a session someone else created. AWS would
  // answer for it happily; the reference selfie handed to the face-match
  // pipeline would simply be the wrong person's. Refuse before spending the
  // provider call.
  if (user.pendingLivenessSessionId !== sessionId) {
    console.warn(`${LOG_PREFIX} session id does not belong to this user`, {
      userId,
      reported: sessionId,
      expected: user.pendingLivenessSessionId,
    });
    return { ok: false, error: "session_mismatch" };
  }

  const result = await getLivenessResult(sessionId);
  if (!result.ok) {
    // Deliberately do NOT clear the binding: a provider blip is not a terminal
    // outcome, and the session may still be readable on a retry within its
    // 3-minute life.
    console.error(`${LOG_PREFIX} could not read session result`, {
      userId,
      error: result.error,
    });
    return { ok: false, error: "provider" };
  }

  // The session reached a terminal state, so release the binding. A replayed
  // `/event` for the same id now answers `session_mismatch` instead of
  // re-entering the flow, and a genuine retry mints a fresh session anyway.
  await prisma.user
    .update({ where: { id: user.id }, data: { pendingLivenessSessionId: null } })
    .catch((err) => {
      console.warn(`${LOG_PREFIX} failed to clear session binding`, { userId, err });
    });

  if (result.outcome !== "passed") {
    // Every non-pass is retryable by design: a failed capture is not evidence
    // of an impostor, so it must not touch `verificationStatus`. The user
    // stays `pending` and simply runs a new session.
    console.warn(`${LOG_PREFIX} liveness not confirmed`, {
      userId,
      outcome: result.outcome,
      status: result.status,
      confidence: result.confidence,
    });
    await sendRetryPrompt(api, user.id, user.telegramId, user.language ?? "en", result.outcome);
    return { ok: true, outcome: "retry" };
  }

  // Passed. The reference image only exists in memory right now — the pipeline
  // persists it to the selfies bucket as its first step, and every later
  // re-check reads that stored copy.
  void runFaceMatchVerificationDefault(userId, sessionId, api, {
    capturedSelfie: { buffer: result.referenceImage, mime: "image/jpeg" },
  }).catch((err) => {
    console.error(`${LOG_PREFIX} face-match pipeline threw`, { userId, sessionId, err });
  });

  return { ok: true, outcome: "processing" };
}

async function sendRetryPrompt(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  language: Language,
  outcome: LivenessRetryOutcome,
): Promise<void> {
  if (telegramId <= 0n) return; // mobile-only user — the app shows its own retry screen
  try {
    // The photo-redo row here is a deliberate escape hatch, not a second fix
    // for THIS problem — profile photos are never looked at on this path (see
    // `livenessRetryMessage`'s doc comment). It stays available for the person
    // who realizes mid-retry that they uploaded someone else's photos, but its
    // label says exactly that so it reads as an unrelated fork, not a second
    // "try this instead".
    const keyboard = await buildVerificationKeyboard(language, userId, {
      photoRedoLabel: t(language, "verifyBtnRedoPhotosSecondary"),
    });
    await api.sendMessage(Number(telegramId), livenessRetryMessage(language, outcome), {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} retry DM failed`, {
      telegramId: String(telegramId),
      err,
    });
  }
}
