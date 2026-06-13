import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { env } from "../config.js";
import { sendMainMenu } from "../handlers/menu/main.js";
import { seedEloFromVisionDefault, type SeedEloResult } from "./elo-seed.js";
import { compareFaces } from "./face-match.js";
import { fetchInquirySelfie, fetchLatestInquiryByReference } from "./persona-api.js";
import { pinStatusBanner } from "./status-banner.js";
import { downloadProfileImage, uploadSelfie } from "./storage.js";
import { sendTicketRewardDM } from "./ticket-reward.js";
import { grantVerificationBonusIfEligible } from "./ticket-wallet.js";

/**
 * Face-match verification pipeline (Phase 6.3 — third iteration).
 *
 * Runs after Persona's hosted-flow webhook reports `inquiry.approved`.
 * Compares the verified Persona selfie against every photo in the user's
 * profile and decides the verification outcome from the per-photo scores
 * using a quorum rule that tolerates uninformative shots.
 *
 * Each photo is bucketed by its `compareFaces` result:
 *   - `pass`       — score ≥ FACE_MATCH_THRESHOLD_VERIFY
 *   - `borderline` — score ∈ [FACE_MATCH_THRESHOLD_REVIEW, FACE_MATCH_THRESHOLD_VERIFY)
 *   - `fail`       — score <  FACE_MATCH_THRESHOLD_REVIEW (face detected but doesn't match)
 *   - `no_face`    — `compareFaces` returned `faceFound=false` (group photo, scenery, etc.)
 *
 * Decision over the detected-face photos (no_face is excluded from the
 * decision — it's not informative either way):
 *   - `verified`        — `pass` count ≥ FACE_MATCH_MIN_VERIFIED_PHOTOS
 *                         AND no `fail` photos. The user is who they say.
 *   - `rejected`        — at least one `fail` photo. A face that *isn't* the
 *                         verified selfie is sitting in the profile —
 *                         likely impostor / wrong-person photo. Hard reject.
 *   - `pending_review`  — anything else (all-borderline, mixed pass+borderline
 *                         under quorum, zero detected faces).
 *
 * This replaces the previous strict-min strategy: a single mislit shot or
 * group photo would tank the whole profile, even when 4 of 5 photos
 * matched cleanly. The new rule excludes uninformative shots (no_face)
 * from scoring while keeping the original anti-impostor floor — a real
 * face below `THRESHOLD_REVIEW` still hard-fails, so a fake-photo attack
 * cannot hide behind a quorum of legitimate shots.
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
 *      button or by `triggerVerificationRerun` (called from the photo
 *      upload/delete handlers when a user edits their profile photos).
 */

export type PendingReviewReason =
  | "borderline_score"
  | "selfie_fetch_failed"
  | "no_source_face"
  | "no_profile_photos"
  | "no_detected_faces"
  | "comparison_error"
  | "photo_download_failed"
  | "face_match_disabled"
  | "photos_changed_during_run";

/**
 * `score` is the **representative** face-match score (0..1) that drove the
 * decision, NOT necessarily the min across photos:
 *   - verified       → highest pass score (most confident match)
 *   - rejected       → lowest detected-face score (the worst offender)
 *   - pending_review → average across detected-face photos (or absent
 *                      when the route was an infra failure / no photos)
 */
export type VerificationOutcome =
  | { kind: "skipped_idempotent"; userId: string }
  | { kind: "skipped_user_missing"; userId: string }
  | { kind: "verified"; userId: string; score: number; scores: number[] }
  | {
      kind: "pending_review";
      userId: string;
      reason: PendingReviewReason;
      score?: number;
      scores?: number[];
    }
  | { kind: "rejected"; userId: string; score: number; scores: number[] };

export type TerminalVerificationStatus = "verified" | "pending_review" | "rejected";

/**
 * Injectable dependencies — production wires them up to the real services
 * via `runFaceMatchVerification`. Tests pass stubs that return canned
 * payloads so the pipeline's branching logic can be verified deterministically.
 */
export interface PipelineDeps {
  fetchInquirySelfie: typeof fetchInquirySelfie;
  uploadSelfie: typeof uploadSelfie;
  /**
   * Source-aware profile-photo download. Pre-bound to the bot's `Api`
   * instance by `runFaceMatchVerificationDefault`, so this signature stays
   * grammY-agnostic and tests can pass a plain stub. Routes by the `/`
   * heuristic in `downloadProfileImage` — Supabase paths contain a slash,
   * Telegram file_ids do not.
   */
  downloadProfileImage: (pathOrFileId: string) => Promise<Buffer | null>;
  compareFaces: typeof compareFaces;
  /** DM the user with the outcome. No-op when telegramId ≤ 0 (mobile-only user). */
  notify: (telegramId: bigint, message: string) => Promise<void>;
  /**
   * Surface the post-verification Telegram app shell after a green face-match:
   * main menu + pinned "next match" status banner. Kept as a hook so the pure
   * pipeline stays testable and mobile-only users can no-op.
   */
  surfaceVerifiedActivation?: (input: {
    userId: string;
    telegramId: bigint;
  }) => Promise<void>;
  /**
   * One-time Date Ticket reward for a successful identity verification.
   * The production hook is ledger-idempotent and feature-flagged; failures
   * never change the verification outcome.
   */
  awardVerificationBonus?: (input: {
    userId: string;
    telegramId: bigint;
  }) => Promise<void>;
  /**
   * Cold-start Elo seed via vision. Optional — when undefined (flag off in prod
   * or unset by tests) the pipeline skips seeding and the user keeps the
   * default Elo of 500. Only invoked on the `verified` branch and only when
   * `profile.eloSeededAt` is null and at least one photo exists. All profile
   * photos are passed together so the seed can use an arithmetic mean. Failures
   * are logged but never block verification — the user is already verified
   * and active by the time this runs.
   */
  seedEloFromVision?: (
    userId: string,
    photoPaths: readonly string[],
  ) => Promise<SeedEloResult>;
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
  verificationStatus: string;
  personaInquiryId: string | null;
  faceMatchedAt: Date | null;
  profile: { photos: string[]; eloSeededAt: Date | null } | null;
}

export interface PipelineConfig {
  thresholdVerify: number;
  thresholdReview: number;
  /**
   * Minimum number of detected-face photos that must score ≥ thresholdVerify
   * for the user to land on the `verified` branch. Anything below quorum
   * (without any hard `fail`) routes to `pending_review`. Defaults to 1 in
   * production; tests pin it explicitly.
   */
  minVerifiedPhotos: number;
}

export interface PersistOutcomeInput {
  userId: string;
  /**
   * Persona inquiry that drove this decision. Persisted so admin can
   * deep-link back to Persona on appeal, and so the idempotency guard
   * `(personaInquiryId, faceMatchedAt)` is complete on subsequent runs.
   */
  inquiryId: string;
  /** Final verification status to write. */
  verificationStatus: "verified" | "pending_review" | "rejected";
  /**
   * Representative face-match score (0..1) for the dashboard.
   *   - `verified`        → highest pass score (most confident match).
   *   - `pending_review`  → average across detected-face photos (or null if
   *                         none were comparable).
   *   - `rejected`        → lowest detected-face score (the worst offender).
   * Null when scoring didn't run (infra failures, no photos, etc.).
   */
  faceMatchScore: number | null;
  /** Per-photo scores (parallel to Profile.photos). Empty array means "leave existing scores in place". */
  photoFaceScores: number[];
  /**
   * Snapshot of `Profile.photos` taken when scoring started. Persistence
   * is gated on the snapshot still matching DB state — if the user added
   * or removed photos mid-run the scores are stale and we drop them.
   * Empty array means "no scores to write" (e.g. infra-failure path);
   * callers MAY still persist verificationStatus via the unconditional
   * `User` update path.
   */
  photosSnapshot: string[];
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
    if (user.verificationStatus === "verified") {
      await awardVerificationBonus(deps, {
        userId,
        telegramId: user.telegramId,
      });
    }
    return { kind: "skipped_idempotent", userId };
  }

  // Pre-condition: user should have profile photos by the time they reach
  // verification. If they don't, route to pending_review — admin should
  // see this and investigate the upstream onboarding bug rather than
  // either approving or rejecting silently.
  //
  // Snapshot the photos array at the start so we can race-detect at
  // persist time. Any photo edit that lands while we're scoring will
  // make `photosSnapshot` stale, and the conditional `updateMany` in
  // production wiring will reject the write — preventing impostor
  // photos from inheriting a `verified` status they never earned.
  const photos = user.profile?.photos ?? [];
  const photosSnapshot = [...photos];
  if (photos.length === 0) {
    console.warn(`${LOG_PREFIX} no profile photos to compare`, { userId, inquiryId });
    await deps.db.persistOutcome({
      userId,
      inquiryId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      photosSnapshot,
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
      inquiryId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      photosSnapshot,
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
  // We track per-photo *kind* alongside the numeric score because the
  // decision rule (Step 4) ignores no-face photos rather than treating
  // them as hard 0 — old behavior was a footgun for users with one
  // group shot in their album.
  type PhotoKind = "scored" | "no_face";
  const scores: number[] = [];
  const kinds: PhotoKind[] = [];
  let infraError: PendingReviewReason | null = null;
  let sourceFaceMissing = false;

  for (let i = 0; i < photos.length; i++) {
    const path = photos[i]!;
    const photoBuffer = await deps.downloadProfileImage(path);
    if (!photoBuffer) {
      console.warn(`${LOG_PREFIX} profile photo download failed`, {
        userId,
        inquiryId,
        path,
      });
      scores.push(0);
      kinds.push("scored");
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
        kinds.push("scored");
        break;
      }
      console.warn(`${LOG_PREFIX} compareFaces error`, {
        userId,
        inquiryId,
        path,
        error: result.error,
      });
      scores.push(0);
      kinds.push("scored");
      infraError ??= "comparison_error";
      continue;
    }

    if (!result.faceFound) {
      // Group photo / scenery / no detectable face. Persisted as score 0
      // for admin-dashboard visibility (so ops can spot the offending
      // photo) but excluded from the verification decision below.
      scores.push(0);
      kinds.push("no_face");
      continue;
    }

    scores.push(result.similarity);
    kinds.push("scored");
  }

  if (sourceFaceMissing) {
    await deps.db.persistOutcome({
      userId,
      inquiryId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      photosSnapshot,
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
      inquiryId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review");
    return { kind: "pending_review", userId, reason: infraError, scores };
  }

  // Step 4: apply the quorum decision rule (see file header).
  //
  //   pass       → score ≥ thresholdVerify
  //   borderline → thresholdReview ≤ score < thresholdVerify
  //   fail       → score < thresholdReview AND face was detected (impostor)
  //   no_face    → faceFound=false (excluded from the decision; not
  //                informative either way — a group shot doesn't tell us
  //                whether the user is themselves or an impostor.)
  //
  //   verified        — pass count ≥ minVerifiedPhotos AND no fail photos
  //   rejected        — at least one fail photo (real face that doesn't match)
  //   pending_review  — anything else (all-borderline, mixed, or zero
  //                     detected-face photos)
  const passCount = scores.filter(
    (s, i) => kinds[i] === "scored" && s >= config.thresholdVerify,
  ).length;
  const failCount = scores.filter(
    (s, i) => kinds[i] === "scored" && s < config.thresholdReview,
  ).length;
  const detectedScores = scores.filter((_, i) => kinds[i] === "scored");

  if (detectedScores.length === 0) {
    // Every photo was a group shot / scenery — nothing to compare.
    // We can't approve, but we also can't blame the user for "no fake
    // face". Send to pending_review and let the admin nudge them to
    // upload solo shots.
    console.warn(`${LOG_PREFIX} no detected faces in any photo`, {
      userId,
      inquiryId,
      scores,
    });
    await deps.db.persistOutcome({
      userId,
      inquiryId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review");
    return {
      kind: "pending_review",
      userId,
      reason: "no_detected_faces",
      scores,
    };
  }

  if (failCount > 0) {
    // At least one detected face is well below threshold → impostor or
    // wrong-person photo. Hard reject.
    const minDetected = Math.min(...detectedScores);
    console.warn(`${LOG_PREFIX} face mismatch → rejected`, {
      userId,
      inquiryId,
      passCount,
      failCount,
      minDetected,
      scores,
      kinds,
    });
    await deps.db.persistOutcome({
      userId,
      inquiryId,
      verificationStatus: "rejected",
      faceMatchScore: minDetected,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "rejected");
    return { kind: "rejected", userId, score: minDetected, scores };
  }

  if (passCount >= config.minVerifiedPhotos) {
    // Quorum cleared and no impostor faces detected — approve.
    const maxDetected = Math.max(...detectedScores);
    await deps.db.persistOutcome({
      userId,
      inquiryId,
      verificationStatus: "verified",
      faceMatchScore: maxDetected,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: true,
    });
    // Cold-start Elo seed runs only here, after the user is committed as
    // verified. Idempotency guard: skip if a previous run already seeded
    // (e.g. an admin rerun on the same already-verified user). Wrapped in
    // try/catch so a vision/Supabase outage never demotes a verified user.
    if (
      deps.seedEloFromVision &&
      user.profile &&
      user.profile.eloSeededAt === null &&
      photos.length > 0
    ) {
      try {
        const seed = await deps.seedEloFromVision(userId, photos);
        if (!seed.ok) {
          console.warn(`${LOG_PREFIX} elo seed skipped`, { userId, reason: seed.error });
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} elo seed threw (swallowed)`, { userId, err });
      }
    }
    await sendOutcomeMessage(deps, user.telegramId, "verified");
    await awardVerificationBonus(deps, {
      userId,
      telegramId: user.telegramId,
    });
    if (user.telegramId > 0n) {
      await surfaceVerifiedActivation(deps, {
        userId,
        telegramId: user.telegramId,
      });
    }
    return { kind: "verified", userId, score: maxDetected, scores };
  }

  // Borderline outcome: nothing failed but quorum wasn't met (e.g.
  // every photo landed in [REVIEW, VERIFY)). Hand to admin.
  const avgDetected =
    detectedScores.reduce((a, b) => a + b, 0) / detectedScores.length;
  console.warn(`${LOG_PREFIX} borderline → pending_review`, {
    userId,
    inquiryId,
    passCount,
    minVerifiedPhotos: config.minVerifiedPhotos,
    avgDetected,
    scores,
    kinds,
  });
  await deps.db.persistOutcome({
    userId,
    inquiryId,
    verificationStatus: "pending_review",
    faceMatchScore: avgDetected,
    photoFaceScores: scores,
    photosSnapshot,
    verifiedSelfiePath,
    shouldActivate: false,
  });
  await sendOutcomeMessage(deps, user.telegramId, "pending_review");
  return {
    kind: "pending_review",
    userId,
    reason: "borderline_score",
    score: avgDetected,
    scores,
  };
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
      return "⚠️ The photos in your profile don't appear to match the selfie we captured during verification. Please replace them with clear photos of yourself, then open Settings → Verify your account to retry.";
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

async function surfaceVerifiedActivation(
  deps: Pick<PipelineDeps, "surfaceVerifiedActivation">,
  input: { userId: string; telegramId: bigint },
): Promise<void> {
  if (!deps.surfaceVerifiedActivation) return;
  try {
    await deps.surfaceVerifiedActivation(input);
  } catch (err) {
    console.warn(`${LOG_PREFIX} post-verification surface failed`, {
      userId: input.userId,
      telegramId: String(input.telegramId),
      err,
    });
  }
}

async function awardVerificationBonus(
  deps: Pick<PipelineDeps, "awardVerificationBonus">,
  input: { userId: string; telegramId: bigint },
): Promise<void> {
  if (!deps.awardVerificationBonus) return;
  try {
    await deps.awardVerificationBonus(input);
  } catch (err) {
    console.warn(`${LOG_PREFIX} verification ticket reward failed`, {
      userId: input.userId,
      err,
    });
  }
}

async function surfaceVerifiedActivationDefault(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
): Promise<void> {
  if (telegramId <= 0n) return; // mobile-only user — mobile renders its own shell

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      telegramId: true,
      language: true,
      status: true,
      verificationStatus: true,
      statusMessageId: true,
    },
  });
  if (!user) return;
  if (user.status !== "active" || user.verificationStatus !== "verified") return;

  // Idempotency guard for reruns/admin rechecks: the banner is created in the
  // same visible landing sequence as the menu. If it already exists, don't
  // re-send the menu on later verification reruns.
  if (user.statusMessageId) return;

  const lang: Language = user.language ?? "en";
  const chatId = Number(user.telegramId);

  try {
    await sendMainMenu(api, chatId, lang, user.telegramId);
  } catch (err) {
    console.warn(`${LOG_PREFIX} main menu send failed`, {
      userId,
      telegramId: String(user.telegramId),
      err,
    });
  }

  await pinStatusBanner(api, user.telegramId, lang);
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
      downloadProfileImage: (path) => downloadProfileImage(path, api),
      compareFaces,
      // Flag-gated: only wire the real seeding when ops have flipped the env
      // var on. Pipeline tests stub their own implementation; without a
      // dep here, the verified branch silently skips Elo seeding and the
      // user keeps the schema-default Elo of 500.
      ...(env.ELO_VISION_SEED_ENABLED
        ? {
            seedEloFromVision: (uid: string, photos: readonly string[]) =>
              seedEloFromVisionDefault(uid, photos, api),
          }
        : {}),
      notify: async (telegramId, message) => {
        await api.sendMessage(Number(telegramId), message);
      },
      surfaceVerifiedActivation: async (input) => {
        await surfaceVerifiedActivationDefault(api, input.userId, input.telegramId);
      },
      awardVerificationBonus: async (input) => {
        const reward = await grantVerificationBonusIfEligible(input.userId);
        if (!reward.granted || input.telegramId <= 0n) return;

        const user = await prisma.user.findUnique({
          where: { id: input.userId },
          select: { language: true },
        });
        await sendTicketRewardDM(
          api,
          Number(input.telegramId),
          user?.language ?? "en",
          "verification",
          reward.balance,
        );
      },
      db: {
        findUser: async (id) => {
          return prisma.user.findUnique({
            where: { id },
            select: {
              id: true,
              telegramId: true,
              status: true,
              verificationStatus: true,
              personaInquiryId: true,
              faceMatchedAt: true,
              profile: { select: { photos: true, eloSeededAt: true } },
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
                personaInquiryId: input.inquiryId,
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
                  personaInquiryId: input.inquiryId,
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
                personaInquiryId: input.inquiryId,
              },
            });
          }

          // Race-protected score persistence: the score array is keyed
          // 1:1 to the photos array we *snapshotted* at pipeline start.
          // If the user added or removed photos while we were running,
          // `photos` will not match `photosSnapshot` and updateMany
          // returns 0 — we drop the stale scores rather than corrupt
          // the index-alignment between photos[i] ↔ photoFaceScores[i].
          //
          // verificationStatus has already been written by the User
          // updates above; the auto-rerun triggered by the photo-edit
          // handler will reconcile it with the new photo set on the
          // next pipeline tick.
          //
          // Skipping when the array is empty preserves prior scores
          // from a previous run (matters when admin reruns and the
          // fetch step fails before we recompute).
          if (input.photoFaceScores.length > 0) {
            const updated = await prisma.profile.updateMany({
              where: {
                userId: input.userId,
                photos: { equals: input.photosSnapshot },
              },
              data: { photoFaceScores: input.photoFaceScores },
            });
            if (updated.count === 0) {
              console.warn(
                "[verification-pipeline] photos changed during run — scores discarded",
                {
                  userId: input.userId,
                  inquiryId: input.inquiryId,
                  snapshotLen: input.photosSnapshot.length,
                },
              );
            }
          }
        },
      },
    },
    {
      thresholdVerify: env.FACE_MATCH_THRESHOLD_VERIFY,
      thresholdReview: env.FACE_MATCH_THRESHOLD_REVIEW,
      minVerifiedPhotos: env.FACE_MATCH_MIN_VERIFIED_PHOTOS,
    },
  );
}

/**
 * Re-trigger the face-match pipeline for a user whose profile photos just
 * changed. Fire-and-forget by design: the photo-edit handlers don't block
 * on Persona / Rekognition latency, but the user's verification state must
 * eventually reconcile with the new photo set.
 *
 * Behaviour:
 *   - If the user has no `personaInquiryId` (never ran Persona), this is a
 *     no-op — there's no reference selfie to compare against.
 *   - Otherwise, clears the `(personaInquiryId, faceMatchedAt)` idempotency
 *     marker so the pipeline re-runs against the new photos, and flips
 *     `verificationStatus` back to `pending` for UI clarity (the user sees
 *     a "checking your photos" state instead of stale `rejected`/`verified`).
 *   - Kicks off `runFaceMatchVerificationDefault` without awaiting; pipeline
 *     errors are logged but never bubble back to the photo-edit handler.
 *
 * Returns a tagged result so the caller can log / surface the path taken;
 * the `kind: 'started'` variant resolves AFTER the rerun has been kicked
 * off but BEFORE it completes.
 */
export type RerunOutcome =
  | { kind: "no_inquiry" }
  | { kind: "user_missing" }
  | { kind: "started"; inquiryId: string };

export async function triggerVerificationRerun(
  userId: string,
  api: Api<RawApi>,
): Promise<RerunOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { personaInquiryId: true },
  });
  if (!user) return { kind: "user_missing" };
  if (!user.personaInquiryId) return { kind: "no_inquiry" };

  // Reset the idempotency marker AND flip status to `pending` so the
  // user sees we're re-checking. We pin the WHERE on `personaInquiryId`
  // to avoid racing with a concurrent webhook that just moved them to a
  // newer inquiry.
  await prisma.user.updateMany({
    where: { id: userId, personaInquiryId: user.personaInquiryId },
    data: { faceMatchedAt: null, verificationStatus: "pending" },
  });

  const inquiryId = user.personaInquiryId;
  // Fire-and-forget; do not await. Errors land in the bot logs.
  void runFaceMatchVerificationDefault(userId, inquiryId, api).catch((err) => {
    console.error("[verification-pipeline] rerun failed", { userId, inquiryId, err });
  });

  return { kind: "started", inquiryId };
}

/**
 * Outcome of a pull-style verification check, fired when the user taps
 * "I'm done" in the bot. The bot maps each variant to a localised DM.
 */
export type PullVerificationOutcome =
  /** Pipeline ran (or was already run idempotently) — see `pipelineOutcome`. */
  | { kind: "pipeline_ran"; pipelineOutcome: VerificationOutcome }
  /** User already in a terminal state — nothing to do. Caller should be silent
   *  or just remind them of their current status. */
  | { kind: "already_done"; verificationStatus: TerminalVerificationStatus }
  /** Persona REST API or our DB lookup failed transiently — ask user to retry. */
  | { kind: "infra_error"; reason: "not_configured" | "api" | "timeout" | "user_missing" }
  /** No inquiry yet for this user (they opened the URL but never started). */
  | { kind: "no_inquiry" }
  /** Persona has the inquiry but it's still being processed (status created/pending/completed-unapproved). */
  | { kind: "still_pending"; personaStatus: string }
  /** Persona declined / the user failed liveness — they need to try again. */
  | { kind: "persona_failed"; personaStatus: string };

/**
 * Pull-fallback for the verification webhook. When the user taps "I'm done"
 * after returning from Persona's hosted flow, we sidestep the webhook (which
 * may not have arrived yet, or in local dev never will) and ask Persona's
 * REST API directly for the most recent inquiry attached to this user's
 * `reference-id`.
 *
 * Idempotency:
 *   - Terminal verification states (`verified` / `rejected` / `pending_review`)
 *     short-circuit BEFORE we hit Persona — no API call, no AWS spend.
 *   - When we do run the pipeline, `runFaceMatchVerification` is itself
 *     idempotent on `(personaInquiryId, faceMatchedAt)`, so a button-mash
 *     during processing is harmless.
 *
 * The webhook path stays primary in production. This is the safety net.
 */
export async function pullVerificationStatus(
  userId: string,
  api: Api<RawApi>,
): Promise<PullVerificationOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, telegramId: true, verificationStatus: true },
  });
  if (!user) return { kind: "infra_error", reason: "user_missing" };

  // Already-terminal short-circuit. Cheap DB lookup avoids burning a
  // Persona API call (and any downstream AWS calls) every time the user
  // re-taps the button after the webhook already settled the case.
  if (
    user.verificationStatus === "verified" ||
    user.verificationStatus === "rejected" ||
    user.verificationStatus === "pending_review"
  ) {
    if (user.verificationStatus === "verified") {
      await surfaceVerifiedActivationDefault(api, userId, user.telegramId);
    }
    return { kind: "already_done", verificationStatus: user.verificationStatus };
  }

  const lookup = await fetchLatestInquiryByReference(userId);
  if (!lookup.ok) {
    return { kind: "infra_error", reason: lookup.error };
  }
  if (lookup.inquiryId === null) {
    return { kind: "no_inquiry" };
  }

  // Persona statuses we treat as "go run the pipeline":
  //   `approved` — explicit pass.
  // Everything else (created/pending/completed/needs_review/declined/failed/expired)
  // is either still in flight or a hard fail — neither should kick the
  // pipeline. `completed` without `approved` is intentionally treated as
  // pending: Persona occasionally emits `completed` first, then flips to
  // `approved` after their post-processing.
  const personaStatus = lookup.status;
  if (personaStatus === "approved") {
    const pipelineOutcome = await runFaceMatchVerificationDefault(
      userId,
      lookup.inquiryId,
      api,
    );
    return { kind: "pipeline_ran", pipelineOutcome };
  }

  if (
    personaStatus === "declined" ||
    personaStatus === "failed" ||
    personaStatus === "expired"
  ) {
    return { kind: "persona_failed", personaStatus };
  }

  // created / pending / completed / needs_review / anything new Persona adds
  return { kind: "still_pending", personaStatus };
}
