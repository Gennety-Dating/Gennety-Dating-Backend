import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { compareFaces } from "./face-match.js";
import { fetchInquirySelfie } from "./persona-api.js";
import { downloadProfilePhoto, uploadSelfie } from "./storage.js";

/**
 * Face-match verification pipeline (Phase 6.3 — second iteration).
 *
 * Runs after Persona's hosted-flow webhook reports `inquiry.approved`.
 * Compares the verified Persona selfie against every photo in the user's
 * profile and chooses the verification outcome based on the *minimum*
 * similarity score across all photos:
 *
 *     minScore ≥ FACE_MATCH_THRESHOLD_VERIFY  → verified  (auto-activate if onboarding)
 *     minScore ≥ FACE_MATCH_THRESHOLD_REVIEW  → pending_review  (admin moderates)
 *     minScore <  FACE_MATCH_THRESHOLD_REVIEW → rejected  (user must re-upload photos)
 *
 * Any *infrastructure* failure (Persona API down, Rekognition error, photo
 * download failure) routes the user to `pending_review` rather than
 * `rejected` — we don't penalise users for our own outages. Admin sees the
 * row in the dashboard and either reruns the pipeline or approves manually.
 *
 * The pipeline is deliberately separated from `persona-webhook.ts` so:
 *   1. The webhook can fire-and-forget (it returns 200 to Persona before
 *      Rekognition latency lands), and
 *   2. The same logic can be triggered from an admin "rerun verification"
 *      button without going back through the webhook code path.
 */

export type PendingReviewReason =
  | "borderline_score"
  | "selfie_fetch_failed"
  | "no_source_face"
  | "no_profile_photos"
  | "comparison_error"
  | "photo_download_failed"
  | "face_match_disabled";

export type VerificationOutcome =
  | { kind: "skipped_idempotent"; userId: string }
  | { kind: "skipped_user_missing"; userId: string }
  | { kind: "verified"; userId: string; minScore: number; scores: number[] }
  | {
      kind: "pending_review";
      userId: string;
      reason: PendingReviewReason;
      minScore?: number;
      scores?: number[];
    }
  | { kind: "rejected"; userId: string; minScore: number; scores: number[] };

/**
 * Injectable dependencies — production wires them up to the real services
 * via `runFaceMatchVerification`. Tests pass stubs that return canned
 * payloads so the pipeline's branching logic can be verified deterministically.
 */
export interface PipelineDeps {
  fetchInquirySelfie: typeof fetchInquirySelfie;
  uploadSelfie: typeof uploadSelfie;
  downloadProfilePhoto: typeof downloadProfilePhoto;
  compareFaces: typeof compareFaces;
  /** DM the user with the outcome. No-op when telegramId ≤ 0 (mobile-only user). */
  notify: (telegramId: bigint, message: string) => Promise<void>;
  /**
   * DB shim so tests can hand in an in-memory store. Production uses the
   * real Prisma client. Only the slices we actually call.
   */
  db: {
    findUser: (userId: string) => Promise<PipelineUserRow | null>;
    persistOutcome: (input: PersistOutcomeInput) => Promise<void>;
  };
}

export interface PipelineUserRow {
  id: string;
  telegramId: bigint;
  status: string;
  personaInquiryId: string | null;
  faceMatchedAt: Date | null;
  profile: { photos: string[] } | null;
}

export interface PipelineConfig {
  thresholdVerify: number;
  thresholdReview: number;
}

export interface PersistOutcomeInput {
  userId: string;
  /** Final verification status to write. */
  verificationStatus: "verified" | "pending_review" | "rejected";
  /** Minimum similarity score (0..1) across all photos. Null when comparison didn't run. */
  faceMatchScore: number | null;
  /** Per-photo scores (parallel to Profile.photos). Empty array means "leave existing scores in place". */
  photoFaceScores: number[];
  /** Selfie storage path (Supabase) — null if upload failed or wasn't attempted. */
  verifiedSelfiePath: string | null;
  /**
   * `true` only on the verified branch — flips `User.status` from
   * `onboarding` → `active` (gated, so admin-moderated states survive).
   */
  shouldActivate: boolean;
}

const LOG_PREFIX = "[verification-pipeline]";

/**
 * Pure pipeline — given dependencies and config, makes the verification
 * decision and persists it. Returns a structured outcome so callers
 * (admin reruns, future replay tooling) can branch on the result without
 * re-deriving it from DB state.
 */
export async function runFaceMatchVerification(
  userId: string,
  inquiryId: string,
  deps: PipelineDeps,
  config: PipelineConfig,
): Promise<VerificationOutcome> {
  const user = await deps.db.findUser(userId);
  if (!user) {
    console.warn(`${LOG_PREFIX} user not found`, { userId, inquiryId });
    return { kind: "skipped_user_missing", userId };
  }

  // Idempotency: if we've already run the pipeline for THIS inquiry, skip.
  // We key on `inquiryId` (not on `verifiedAt` alone) so a re-verification
  // attempt — new Persona inquiry, possibly different result — DOES re-run.
  if (user.personaInquiryId === inquiryId && user.faceMatchedAt !== null) {
    return { kind: "skipped_idempotent", userId };
  }

  // Pre-condition: user should have profile photos by the time they reach
  // verification. If they don't, route to pending_review — admin should
  // see this and investigate the upstream onboarding bug rather than
  // either approving or rejecting silently.
  const photos = user.profile?.photos ?? [];
  if (photos.length === 0) {
    console.warn(`${LOG_PREFIX} no profile photos to compare`, { userId, inquiryId });
    await deps.db.persistOutcome({
      userId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      verifiedSelfiePath: null,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review");
    return { kind: "pending_review", userId, reason: "no_profile_photos" };
  }

  // Step 1: pull the verified selfie from Persona.
  const selfieResult = await deps.fetchInquirySelfie(inquiryId);
  if (!selfieResult.ok) {
    console.error(`${LOG_PREFIX} selfie fetch failed`, {
      userId,
      inquiryId,
      error: selfieResult.error,
    });
    await deps.db.persistOutcome({
      userId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      verifiedSelfiePath: null,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review");
    return { kind: "pending_review", userId, reason: "selfie_fetch_failed" };
  }

  const { buffer: selfieBuffer, mime: selfieMime } = selfieResult.selfie;

  // Step 2: persist the selfie in our `selfies` bucket. We store it for
  // (a) re-checks when the user uploads a new photo within the 90-day
  // window and (b) admin spot-checks. A failed upload is not fatal —
  // we proceed to the compare step and persist verifiedSelfiePath=null
  // (re-fetch from Persona on demand).
  let verifiedSelfiePath: string | null = null;
  try {
    const uploaded = await deps.uploadSelfie(userId, selfieBuffer, selfieMime);
    verifiedSelfiePath = uploaded.path;
  } catch (err) {
    console.warn(`${LOG_PREFIX} selfie storage upload failed (non-fatal)`, {
      userId,
      inquiryId,
      err,
    });
  }

  // Step 3: download profile photos and compare each against the selfie.
  // Score conventions:
  //   - download failed → push 0 + set infraError; pipeline ends in pending_review
  //   - compareFaces returns ok:false → same
  //   - compareFaces returns ok:true with faceFound=false → score 0 (a
  //     profile photo without a face is invalid; treated as a hard 0,
  //     which on its own forces a rejection — but the per-photo score
  //     persisted lets admin see WHICH photo is the problem)
  const scores: number[] = [];
  let infraError: PendingReviewReason | null = null;
  let sourceFaceMissing = false;

  for (let i = 0; i < photos.length; i++) {
    const path = photos[i]!;
    const photoBuffer = await deps.downloadProfilePhoto(path);
    if (!photoBuffer) {
      console.warn(`${LOG_PREFIX} profile photo download failed`, {
        userId,
        inquiryId,
        path,
      });
      scores.push(0);
      infraError ??= "photo_download_failed";
      continue;
    }

    const result = await deps.compareFaces(selfieBuffer, photoBuffer);
    if (!result.ok) {
      if (result.error === "no_source_face") {
        // Persona accepted a selfie without a detectable face. Pipeline
        // bug, not user bug. Bail to pending_review with a distinct reason
        // so the admin sees this and re-runs the inquiry.
        console.error(`${LOG_PREFIX} no_source_face on Persona selfie`, {
          userId,
          inquiryId,
        });
        sourceFaceMissing = true;
        scores.push(0);
        break;
      }
      console.warn(`${LOG_PREFIX} compareFaces error`, {
        userId,
        inquiryId,
        path,
        error: result.error,
      });
      scores.push(0);
      infraError ??= "comparison_error";
      continue;
    }

    scores.push(result.faceFound ? result.similarity : 0);
  }

  if (sourceFaceMissing) {
    await deps.db.persistOutcome({
      userId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review");
    return { kind: "pending_review", userId, reason: "no_source_face" };
  }

  if (infraError) {
    // Persist the partial scores so the admin dashboard surfaces which
    // photo failed; the user lands in pending_review either way.
    await deps.db.persistOutcome({
      userId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: scores,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review");
    return { kind: "pending_review", userId, reason: infraError, scores };
  }

  // Step 4: apply thresholds. The MINIMUM score wins — if any photo is
  // suspect, the whole profile is suspect. (We *could* allow some photos
  // below threshold if a majority pass, but the dating-app threat model
  // is "one fake photo is enough to mislead a match" so strictness is
  // the right default.)
  const minScore = Math.min(...scores);

  if (minScore >= config.thresholdVerify) {
    await deps.db.persistOutcome({
      userId,
      verificationStatus: "verified",
      faceMatchScore: minScore,
      photoFaceScores: scores,
      verifiedSelfiePath,
      shouldActivate: true,
    });
    await sendOutcomeMessage(deps, user.telegramId, "verified");
    return { kind: "verified", userId, minScore, scores };
  }

  if (minScore >= config.thresholdReview) {
    console.warn(`${LOG_PREFIX} borderline score → pending_review`, {
      userId,
      inquiryId,
      minScore,
      scores,
    });
    await deps.db.persistOutcome({
      userId,
      verificationStatus: "pending_review",
      faceMatchScore: minScore,
      photoFaceScores: scores,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review");
    return {
      kind: "pending_review",
      userId,
      reason: "borderline_score",
      minScore,
      scores,
    };
  }

  console.warn(`${LOG_PREFIX} face mismatch → rejected`, {
    userId,
    inquiryId,
    minScore,
    scores,
  });
  await deps.db.persistOutcome({
    userId,
    verificationStatus: "rejected",
    faceMatchScore: minScore,
    photoFaceScores: scores,
    verifiedSelfiePath,
    shouldActivate: false,
  });
  await sendOutcomeMessage(deps, user.telegramId, "rejected");
  return { kind: "rejected", userId, minScore, scores };
}

/**
 * DM copy is intentionally English-only here, matching the style of the
 * pre-existing webhook handler. The bot's i18n strings live in
 * `packages/shared/src/i18n.ts` and would need keys added there + a
 * language lookup; deferred to the i18n sweep, not part of this feature.
 */
function outcomeMessage(kind: "verified" | "pending_review" | "rejected"): string {
  switch (kind) {
    case "verified":
      return "✅ Verification complete — your profile is live. I'll reach out when I find a match.";
    case "pending_review":
      return "🔍 We're double-checking your profile photos against your verification selfie. This usually takes a few hours — I'll message you the moment it's done.";
    case "rejected":
      return "⚠️ The photos in your profile don't appear to match the selfie we captured during verification. Please replace them with clear photos of yourself and retry verification from the menu.";
  }
}

async function sendOutcomeMessage(
  deps: Pick<PipelineDeps, "notify">,
  telegramId: bigint,
  kind: "verified" | "pending_review" | "rejected",
): Promise<void> {
  if (telegramId <= 0n) return; // mobile-only user — no Telegram chat to DM
  try {
    await deps.notify(telegramId, outcomeMessage(kind));
  } catch (err) {
    console.warn(`${LOG_PREFIX} outcome DM failed`, { telegramId: String(telegramId), err });
  }
}

/**
 * Production wiring: builds default deps from the bot's `Api` + the real
 * services and runs the pipeline. Called by the Persona webhook handler
 * after liveness passes; will also be called by the admin "rerun" button
 * once that ships in Step 4.
 */
export async function runFaceMatchVerificationDefault(
  userId: string,
  inquiryId: string,
  api: Api<RawApi>,
): Promise<VerificationOutcome> {
  return runFaceMatchVerification(
    userId,
    inquiryId,
    {
      fetchInquirySelfie,
      uploadSelfie,
      downloadProfilePhoto,
      compareFaces,
      notify: async (telegramId, message) => {
        await api.sendMessage(Number(telegramId), message);
      },
      db: {
        findUser: async (id) => {
          return prisma.user.findUnique({
            where: { id },
            select: {
              id: true,
              telegramId: true,
              status: true,
              personaInquiryId: true,
              faceMatchedAt: true,
              profile: { select: { photos: true } },
            },
          });
        },
        persistOutcome: async (input) => {
          const now = new Date();
          // Status flip is gated on `onboarding` → `active` so admin-moderated
          // states (paused, suspended, banned) survive a verified outcome.
          // Mirrors the original webhook handler's protection.
          if (input.shouldActivate) {
            const activated = await prisma.user.updateMany({
              where: { id: input.userId, status: "onboarding" },
              data: {
                verificationStatus: input.verificationStatus,
                verifiedAt: now,
                status: "active",
                faceMatchScore: input.faceMatchScore,
                faceMatchedAt: now,
                verifiedSelfiePath: input.verifiedSelfiePath,
              },
            });
            if (activated.count === 0) {
              await prisma.user.updateMany({
                where: { id: input.userId, status: { not: "onboarding" } },
                data: {
                  verificationStatus: input.verificationStatus,
                  verifiedAt: now,
                  faceMatchScore: input.faceMatchScore,
                  faceMatchedAt: now,
                  verifiedSelfiePath: input.verifiedSelfiePath,
                },
              });
            }
          } else {
            await prisma.user.update({
              where: { id: input.userId },
              data: {
                verificationStatus: input.verificationStatus,
                faceMatchScore: input.faceMatchScore,
                faceMatchedAt: now,
                verifiedSelfiePath: input.verifiedSelfiePath,
              },
            });
          }

          // Always update profile scores when we have them. Skipping when
          // the array is empty preserves prior scores from a previous run
          // (matters when an admin reruns and the fetch step fails before
          // we recompute).
          if (input.photoFaceScores.length > 0) {
            await prisma.profile.update({
              where: { userId: input.userId },
              data: { photoFaceScores: input.photoFaceScores },
            });
          }
        },
      },
    },
    {
      thresholdVerify: env.FACE_MATCH_THRESHOLD_VERIFY,
      thresholdReview: env.FACE_MATCH_THRESHOLD_REVIEW,
    },
  );
}
