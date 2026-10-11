import { InlineKeyboard, type Api, type RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { MIN_PHOTOS, t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import {
  createLivenessSession,
  getLivenessResult,
  type LivenessRetryOutcome,
} from "./face-liveness.js";
import { mintLivenessCredentials, type LivenessCredentials } from "./liveness-credentials.js";
import type { OutcomeGate } from "./outcome-gate.js";
import {
  activationBlockerFor,
  runFaceMatchVerificationDefault,
  trackFaceMatchRun,
  VERIFICATION_PUSH_TYPE,
} from "./verification-pipeline.js";
import { deleteStorageObject, uploadSelfie } from "./storage.js";
import { notifyFounderVerificationManualReview } from "./founder-notify.js";
import { pushReachable, telegramReachable } from "./telegram-reach.js";
import { sendPushToUser } from "./push.js";
import { DEMO_MODE_ENABLED } from "../demo/config.js";
import { releaseDemoLivenessSession, runDemoVerification } from "../demo/verification.js";
import { buildVerificationKeyboard, VERIFY_PHOTOS_CALLBACK } from "./verification-keyboard.js";
import {
  livenessRetryMessage,
  terminalVerificationMessage,
  terminalVerificationPush,
} from "./verification-messages.js";

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
  /**
   * 409 — the account waits in `pending_review` for a human. Neither client
   * offers a check there; a direct caller re-running one would take the
   * first-check path and could verify itself against photos nobody reviewed.
   */
  | { ok: false; error: "under_review" }
  /** 409 — no explicit Art. 9 biometric consent on file yet. */
  | { ok: false; error: "consent_required" }
  /**
   * 409 — a first check for an account that has not finished registering
   * (onboarding incomplete, or no verified track contact). Both clients only
   * offer verification after onboarding, so this is the server holding the
   * same order for a caller that skips the UI (audit A13-M18).
   */
  | { ok: false; error: "onboarding_incomplete" }
  /**
   * 409 — the profile has fewer than MIN_PHOTOS photos, so a passing check
   * would have too little to be compared against (audit A13-H11). `language` lets the route answer in
   * the user's own words.
   */
  | { ok: false; error: "photos_required"; language: Language }
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

export interface CompleteLivenessOptions {
  /**
   * Handshake with a caller-owned "analysing your check" status
   * (`services/outcome-gate.ts`). When present, the face-match pipeline holds
   * its outcome DM until the caller releases the gate, and signals the gate
   * when it is ready to speak (or has finished silently) so the status can end
   * on cue. Omit on surfaces that narrate nothing — the native client renders
   * its own progress screen.
   */
  outcomeGate?: OutcomeGate;
}

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
      biometricConsentAt: true,
      onboardingStep: true,
      registrationTrack: true,
      email: true,
      isEmailVerified: true,
      phoneVerifiedAt: true,
      profile: { select: { photos: true } },
    },
  });
  if (!user) return { ok: false, error: "user_not_found" };
  if (user.verificationStatus === "pending_review") return { ok: false, error: "under_review" };

  // Re-running liveness on an already-verified user would burn a check and a
  // session for no decision; the client renders a "you're verified" screen.
  //
  // ONE exception, and it is the whole point of `reference_expired`
  // (PRODUCT_SPEC §1.4 rule 5): the 90-day scrub deleted the reference selfie,
  // AWS cannot re-issue it, and every surface that touches photos — the photo
  // manager, `POST /v1/me/photos`, chat agent — answers "verify again to change
  // your photos". Refusing here made that instruction impossible to follow:
  // the user was told to re-verify by the only product that could refuse it.
  const referenceExpired = !user.verifiedSelfiePath;
  const alreadyVerified = user.verificationStatus === "verified";
  const checkWouldRun = !alreadyVerified || referenceExpired;

  // Two things that make a check pointless, asked before the consent screen so
  // nobody is walked through a biometric disclosure for a check that cannot
  // run yet — and only when one would actually run, so a verified user still
  // gets their "you're verified" answer.
  if (checkWouldRun) {
    // A first verification belongs after registration. Both clients already
    // put it there; without the same order here, a direct API caller could get
    // verified — and, before activation was gated, activated with a referral
    // payout — without finishing onboarding or proving a track contact (audit
    // A13-M18). A verified user re-running for an expired reference is exempt:
    // they are not being admitted, only re-anchored.
    if (!alreadyVerified && activationBlockerFor(user) !== null) {
      return { ok: false, error: "onboarding_incomplete" };
    }
    // Nothing to compare the selfie with. Letting the check run anyway wrote
    // `pending_review` and nulled the stored selfie, a dead end with no button
    // (audit A13-H11); asking for photos first is the step that moves them.
    // Below the minimum counts the same as none: the client's photo step and
    // the collector both ask for MIN_PHOTOS, and a check over fewer is a check
    // the user would have to repeat once they add the rest.
    //
    // A verified user re-anchoring an expired reference has no floor at all
    // (C-12): the minimum gates matching, not identity, and adding photos is
    // exactly what their expired reference refuses — demanding any first was a
    // loop with no way out. With photos the pipeline compares as usual; with
    // none, `completeLivenessCheck` hands the pass to a human (manual review).
    const photoCount = user.profile?.photos.length ?? 0;
    const photoFloor = alreadyVerified ? 0 : MIN_PHOTOS;
    if (photoCount < photoFloor) {
      return { ok: false, error: "photos_required", language: user.language ?? "en" };
    }
  }

  // GDPR Art. 9(2)(a): biometric processing needs an EXPLICIT act of consent
  // for this processing specifically. Tapping a "Verify" button under copy
  // that never mentions biometrics is not one, and the general ToS tick at
  // sign-up is not one either — so the session is refused until the dedicated
  // consent screen has been through `recordBiometricConsent`. This is the
  // gate, not the UI: both clients must pass it, and a client that skips its
  // own screen gets a 409 rather than a session.
  if (!user.biometricConsentAt) return { ok: false, error: "consent_required" };
  if (!checkWouldRun) {
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
 * Record the user's explicit consent to biometric processing (Art. 9(2)(a)),
 * shared by the Mini App and the native client.
 *
 * Idempotent by design: the FIRST consent is the one that counts, so a second
 * tap (a retry after a failed check, a re-opened Mini App) does not overwrite
 * the original timestamp. It does refresh the version when the disclosure text
 * has moved on, so the row always answers "which text did they last agree to".
 *
 * Withdrawal is deliberately NOT here — it is a support path today, because
 * withdrawing also has to erase the reference selfie and pull the user out of
 * matching (`legal/privacy-policy.md` §18).
 */
export async function recordBiometricConsent(
  userId: string,
  version: string,
): Promise<{ ok: boolean }> {
  try {
    // Compare-and-set on `biometricConsentAt IS NULL` so the original moment of
    // consent survives every later tap.
    const claimed = await prisma.user.updateMany({
      where: { id: userId, biometricConsentAt: null },
      data: { biometricConsentAt: new Date(), biometricConsentVersion: version },
    });
    if (claimed.count === 0) {
      // Already consented — keep the first timestamp, record that they have now
      // also seen the current text.
      await prisma.user.update({
        where: { id: userId },
        data: { biometricConsentVersion: version },
      });
    }
    return { ok: true };
  } catch (err) {
    console.warn(`${LOG_PREFIX} recordBiometricConsent failed`, { userId, err });
    return { ok: false };
  }
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
  options: CompleteLivenessOptions = {},
): Promise<CompleteLivenessResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      telegramId: true,
      platform: true,
      language: true,
      pendingLivenessSessionId: true,
      verificationStatus: true,
      verifiedSelfiePath: true,
      profile: { select: { photos: true } },
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

  // Demo mode (DEMO_MODE.md): the visitor just ran the genuine camera flow,
  // but the demo does not ask AWS what it thought and does not compare any
  // faces — the whole point is that a visitor who uploaded three pictures of a
  // cat still gets through. Everything downstream is the untouched pipeline.
  if (DEMO_MODE_ENABLED) {
    await releaseDemoLivenessSession(user.id);
    // Tracked like the production run, so `GET /v1/me/verification` says
    // `checking` for a demo visitor too.
    void trackFaceMatchRun(
      user.id,
      runDemoVerification(user.id, sessionId, api, options.outcomeGate),
    )
      .catch((err) => {
        console.error(`${LOG_PREFIX} demo verification threw`, { userId, err });
      })
      .finally(() => options.outcomeGate?.finish());
    return { ok: true, outcome: "processing" };
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

  // Passed, but there is nothing to compare it with AND nothing tying the
  // account to its earlier face (C-12): verified, reference scrubbed, zero
  // photos. The pipeline would only park it as retryable — the old dead end.
  // A human decides instead (founder decision 2026-10-11).
  if (needsManualReanchorReview(user)) {
    void trackFaceMatchRun(
      user.id,
      parkForManualReview(user, result.referenceImage, api, options.outcomeGate),
    )
      .catch((err) => {
        console.error(`${LOG_PREFIX} manual-review park threw`, { userId, err });
      })
      .finally(() => options.outcomeGate?.finish());
    return { ok: true, outcome: "processing" };
  }

  // Passed. The reference image only exists in memory right now — the pipeline
  // persists it to the selfies bucket as its first step, and every later
  // re-check reads that stored copy.
  void runFaceMatchVerificationDefault(userId, sessionId, api, {
    capturedSelfie: { buffer: result.referenceImage, mime: "image/jpeg" },
    ...(options.outcomeGate ? { outcomeGate: options.outcomeGate } : {}),
  })
    .catch((err) => {
      console.error(`${LOG_PREFIX} face-match pipeline threw`, { userId, sessionId, err });
    })
    // Whatever happened, the run is over — tell the caller's status it can
    // stop holding. Without this a run that says nothing (a rerun that merely
    // re-confirms an already-verified user) or one that threw would leave the
    // shimmer holding its last beat until the gate's safety cap.
    .finally(() => options.outcomeGate?.finish());

  return { ok: true, outcome: "processing" };
}

/**
 * The C-12 escape: a VERIFIED account whose reference selfie the 90-day scrub
 * deleted and which has no profile photos left. A passing check proves a live
 * person, but nothing links that person to the face verified before — so the
 * pass is never auto-accepted.
 */
export function needsManualReanchorReview(user: {
  verificationStatus: string;
  verifiedSelfiePath: string | null;
  profile: { photos: string[] } | null;
}): boolean {
  return (
    user.verificationStatus === "verified" &&
    !user.verifiedSelfiePath &&
    (user.profile?.photos.length ?? 0) === 0
  );
}

/**
 * Store the new reference selfie and move the account to the existing
 * manual-review state (`pending_review`), then tell the founder and the user.
 *
 * `personaInquiryId` is cleared on purpose: `triggerVerificationRerun` answers
 * `no_inquiry` without one, so a photo uploaded while the review is open can
 * never re-score the account into `verified` on its own — only the founder
 * can. Once the founder sets `verified`, uploads are gated against the new
 * `verifiedSelfiePath` like any verified account's.
 *
 * The write is a compare-and-set on the stuck state, so a duplicate `/event`
 * or a concurrent run cannot demote an account that has moved on.
 */
async function parkForManualReview(
  user: {
    id: string;
    telegramId: bigint;
    platform: string | null;
    language: Language | null;
  },
  referenceImage: Buffer,
  api: Api<RawApi>,
  outcomeGate: OutcomeGate | undefined,
): Promise<void> {
  let selfiePath: string;
  try {
    selfiePath = (await uploadSelfie(user.id, referenceImage, "image/jpeg")).path;
  } catch (err) {
    // Without a stored selfie the founder has nothing to review and an
    // approval would land on `reference_expired` again. Leave the account
    // exactly as it was (still verified) and let them run the check again.
    console.error(`${LOG_PREFIX} manual-review selfie upload failed`, { userId: user.id, err });
    await sendRetryPrompt(api, user.id, user.telegramId, user.language ?? "en", "no_reference");
    return;
  }

  const parked = await prisma.user.updateMany({
    where: { id: user.id, verificationStatus: "verified", verifiedSelfiePath: null },
    data: {
      verificationStatus: "pending_review",
      verifiedSelfiePath: selfiePath,
      personaInquiryId: null,
      faceMatchedAt: null,
    },
  });
  if (parked.count === 0) {
    console.warn(`${LOG_PREFIX} manual-review park skipped — account moved on`, {
      userId: user.id,
    });
    const removed = await deleteStorageObject(env.SUPABASE_SELFIE_BUCKET, selfiePath).catch(
      () => false,
    );
    if (!removed) {
      console.warn(`${LOG_PREFIX} unused manual-review selfie not removed`, {
        userId: user.id,
        selfiePath,
      });
    }
    return;
  }
  console.warn(`${LOG_PREFIX} verified account with no photos → pending_review (manual)`, {
    userId: user.id,
  });

  void notifyFounderVerificationManualReview(user.id).catch((err: unknown) => {
    console.warn(`${LOG_PREFIX} founder manual-review notice failed`, { userId: user.id, err });
  });

  const language = user.language ?? "en";
  if (telegramReachable(user)) {
    await outcomeGate?.hold();
    await api
      .sendMessage(Number(user.telegramId), terminalVerificationMessage(language, "pending_review"))
      .catch((err: unknown) => {
        console.warn(`${LOG_PREFIX} manual-review DM failed`, { userId: user.id, err });
      });
  }
  if (pushReachable(user)) {
    const push = terminalVerificationPush(language, "pending_review");
    await sendPushToUser(user.id, {
      title: push.title,
      body: push.body,
      data: { type: VERIFICATION_PUSH_TYPE, status: "pending_review" },
    }).catch((err: unknown) => {
      console.warn(`${LOG_PREFIX} manual-review push failed`, { userId: user.id, err });
    });
  }
}

/**
 * The Telegram half of a `photos_required` refusal: the Mini App can only say
 * "add photos first" and close, so the action itself — the photo manager —
 * arrives in the chat the user is returned to. One button, not the verify
 * keyboard: running the check again is exactly what cannot work yet.
 */
export async function sendPhotosRequiredPrompt(
  api: Api<RawApi>,
  telegramId: bigint,
  language: Language,
): Promise<void> {
  if (telegramId <= 0n) return; // mobile-only user — the app renders its own step
  try {
    await api.sendMessage(
      Number(telegramId),
      t(language, "verifyPhotosRequired", { min: MIN_PHOTOS }),
      {
        reply_markup: new InlineKeyboard().text(
          t(language, "verifyBtnAddPhotos"),
          VERIFY_PHOTOS_CALLBACK,
        ),
      },
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} photos-required DM failed`, {
      telegramId: String(telegramId),
      err,
    });
  }
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
      parse_mode: "Markdown",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} retry DM failed`, {
      telegramId: String(telegramId),
      err,
    });
  }
}
