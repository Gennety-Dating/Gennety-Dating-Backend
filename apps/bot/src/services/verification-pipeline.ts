import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { env } from "../config.js";
import { sendMainMenu } from "../handlers/menu/main.js";
import { seedEloFromVisionDefault, type SeedEloResult } from "./elo-seed.js";
import { tagAndPersistAppearanceDefault } from "./appearance-tags.js";
import { compareFaces } from "./face-match.js";
import {
  capturedSelfieSource,
  storedSelfieSource,
  type CapturedSelfie,
  type ReferenceSelfieResult,
} from "./identity-selfie.js";
import { pinStatusBanner } from "./status-banner.js";
import { downloadProfileImage, uploadSelfie } from "./storage.js";
import { notifyFounderNewUser } from "./founder-notify.js";
import { settleReferralOnVerified } from "./referral-notify.js";
import { terminalVerificationMessage } from "./verification-messages.js";
import { buildVerificationKeyboard } from "./verification-keyboard.js";

/**
 * Face-match verification pipeline (Phase 6.3 — third iteration).
 *
 * Runs once AWS Rekognition Face Liveness confirms a live human and hands back
 * a reference selfie (previously: Persona's `inquiry.approved` webhook).
 * Compares that verified selfie against every photo in the user's profile and
 * decides the verification outcome from the per-photo scores using a quorum
 * rule that tolerates uninformative shots.
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
 * Any *infrastructure* failure (storage down, Rekognition error, photo
 * download failure) routes the user to `pending_review` rather than
 * `rejected` — we don't penalise users for our own outages. Admin sees the
 * row in the dashboard and either reruns the pipeline or approves manually.
 *
 * The pipeline is deliberately separated from the verification routes so:
 *   1. The route can fire-and-forget (it answers the client before
 *      Rekognition latency lands), and
 *   2. The same logic can be triggered from an admin "rerun verification"
 *      button or by `triggerVerificationRerun` (called from the photo
 *      upload/delete handlers when a user edits their profile photos).
 *
 * Where the reference selfie comes from is NOT this module's business — see
 * `identity-selfie.ts`. A fresh liveness capture and a rerun reading the
 * stored copy enter through the same `fetchReferenceSelfie` dep.
 */

export type PendingReviewReason =
  | "borderline_score"
  | "selfie_fetch_failed"
  /** No reference selfie at all (90-day scrub already ran). Normally caught
   *  before the pipeline starts — see `triggerVerificationRerun`. */
  | "reference_expired"
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
  /**
   * Resolve the reference selfie for this run. A thunk, not a lookup by id,
   * because the two origins differ structurally: a fresh liveness capture
   * already holds the bytes, while a rerun reads them back out of storage.
   * See `identity-selfie.ts`.
   */
  fetchReferenceSelfie: () => Promise<ReferenceSelfieResult>;
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
  /**
   * DM the user with the outcome. No-op when telegramId ≤ 0 (mobile-only user).
   * `message` is already localized to the user's language; `kind` is passed so
   * the production wiring can attach the right affordances without re-deriving
   * them from the copy (a `rejected` DM carries the retry / re-upload buttons).
   */
  notify: (
    telegramId: bigint,
    message: string,
    kind: TerminalVerificationStatus,
  ) => Promise<void>;
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
   * Type Radar candidate tagging via an ISOLATED vision pass (§Type Radar,
   * step 6). Optional and independent of the Elo seed — when undefined (feature
   * flag off, or unset by tests) the pipeline skips it and `V_type` stays
   * neutral for this candidate. Runs only on the `verified` branch, best-effort;
   * a failure never blocks verification (same contract as `seedEloFromVision`).
   */
  tagAppearance?: (
    userId: string,
    photoPaths: readonly string[],
    gender: string | null,
  ) => Promise<unknown>;
  /**
   * Referral settlement (§Referral): if this newly-verified user was invited
   * via a `referral:<id>` link, pay the referrer their milestone rung(s) and DM
   * them. Optional + best-effort — undefined in tests, and a failure never
   * blocks verification. Not gated on `telegramId > 0n`, so a mobile invitee
   * still rewards their referrer. No-ops when the feature flag is off.
   */
  settleReferralReward?: (userId: string) => Promise<void>;
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
  gender: string | null;
  /** Drives the localized outcome DM; `en` when unset. */
  language: Language | null;
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

/**
 * Per-run context that is NOT derivable from DB state at pipeline time.
 */
export interface PipelineRunOptions {
  /**
   * The user's `verificationStatus` as it stood BEFORE this run was kicked
   * off. Only `triggerVerificationRerun` can supply it: the rerun flips the
   * column to `pending` before launching the pipeline, so by the time
   * `db.findUser` reads the row the previous state is already gone.
   *
   * Used for one thing — silencing the `verified` outcome DM on a rerun that
   * merely re-confirms an already-verified user. Every profile-photo edit
   * fires a rerun (menu photo manager, mobile `/v1/me/photos`, Aether), so
   * without this an active user gets "Проверка пройдена ✨ Профиль активен"
   * again every time they touch their photos, even though nothing changed.
   * The DM is only suppressed for `verified → verified`; any status the user
   * can act on (`rejected`, `pending_review`) is always announced.
   */
  previousVerificationStatus?: string | null;
}

export interface PersistOutcomeInput {
  userId: string;
  /**
   * Face Liveness session that produced the reference selfie for this
   * decision. Persisted (in the legacy `personaInquiryId` column, kept under
   * its old name so the provider swap needed no migration) so the idempotency
   * guard `(personaInquiryId, faceMatchedAt)` is complete on subsequent runs
   * and so ops can correlate a decision with a CloudTrail entry.
   */
  sessionId: string;
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
  sessionId: string,
  deps: PipelineDeps,
  config: PipelineConfig,
  options: PipelineRunOptions = {},
): Promise<VerificationOutcome> {
  const user = await deps.db.findUser(userId);
  if (!user) {
    console.warn(`${LOG_PREFIX} user not found`, { userId, sessionId });
    return { kind: "skipped_user_missing", userId };
  }

  // Idempotency: if we've already run the pipeline for THIS inquiry, skip.
  // We key on `sessionId` (not on `verifiedAt` alone) so a re-verification
  // attempt — new liveness session, possibly different result — DOES re-run.
  if (user.personaInquiryId === sessionId && user.faceMatchedAt !== null) {
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
    console.warn(`${LOG_PREFIX} no profile photos to compare`, { userId, sessionId });
    await deps.db.persistOutcome({
      userId,
      sessionId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      photosSnapshot,
      verifiedSelfiePath: null,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review", user.language);
    return { kind: "pending_review", userId, reason: "no_profile_photos" };
  }

  // Step 1: resolve the reference selfie (fresh liveness capture, or the
  // stored copy on a rerun — see `identity-selfie.ts`).
  const selfieResult = await deps.fetchReferenceSelfie();
  if (!selfieResult.ok) {
    console.error(`${LOG_PREFIX} reference selfie unavailable`, {
      userId,
      sessionId,
      error: selfieResult.error,
    });
    const reason: PendingReviewReason =
      selfieResult.error === "reference_expired"
        ? "reference_expired"
        : "selfie_fetch_failed";
    await deps.db.persistOutcome({
      userId,
      sessionId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      photosSnapshot,
      verifiedSelfiePath: null,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review", user.language);
    return { kind: "pending_review", userId, reason };
  }

  const {
    buffer: selfieBuffer,
    mime: selfieMime,
    storedPath,
  } = selfieResult.selfie;

  // Step 2: persist the selfie in our `selfies` bucket. It is the ONLY copy
  // that survives — the liveness session that produced it expires after 3
  // minutes — so it backs every later re-check (photo edits, admin reruns)
  // until the 90-day retention scrub. A failed upload is not fatal here: we
  // still score this run, but with no stored reference the user will have to
  // re-run liveness the next time their photos change.
  //
  // When the bytes CAME from storage (a rerun) there is nothing to upload —
  // re-uploading would litter the bucket with a duplicate object on every
  // photo edit — so we carry the existing path through instead.
  let verifiedSelfiePath: string | null = storedPath ?? null;
  if (!storedPath) {
    try {
      const uploaded = await deps.uploadSelfie(userId, selfieBuffer, selfieMime);
      verifiedSelfiePath = uploaded.path;
    } catch (err) {
      console.warn(`${LOG_PREFIX} selfie storage upload failed (non-fatal)`, {
        userId,
        sessionId,
        err,
      });
    }
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
        sessionId,
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
        // The liveness provider handed us a reference frame with no
        // detectable face. Pipeline bug, not user bug. Bail to pending_review
        // with a distinct reason so the admin sees this and re-runs.
        console.error(`${LOG_PREFIX} no_source_face on reference selfie`, {
          userId,
          sessionId,
        });
        sourceFaceMissing = true;
        scores.push(0);
        kinds.push("scored");
        break;
      }
      console.warn(`${LOG_PREFIX} compareFaces error`, {
        userId,
        sessionId,
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
      sessionId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: [],
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review", user.language);
    return { kind: "pending_review", userId, reason: "no_source_face" };
  }

  if (infraError) {
    // Persist the partial scores so the admin dashboard surfaces which
    // photo failed; the user lands in pending_review either way.
    await deps.db.persistOutcome({
      userId,
      sessionId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review", user.language);
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
      sessionId,
      scores,
    });
    await deps.db.persistOutcome({
      userId,
      sessionId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "pending_review", user.language);
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
      sessionId,
      passCount,
      failCount,
      minDetected,
      scores,
      kinds,
    });
    await deps.db.persistOutcome({
      userId,
      sessionId,
      verificationStatus: "rejected",
      faceMatchScore: minDetected,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    await sendOutcomeMessage(deps, user.telegramId, "rejected", user.language);
    return { kind: "rejected", userId, score: minDetected, scores };
  }

  if (passCount >= config.minVerifiedPhotos) {
    // Quorum cleared and no impostor faces detected — approve.
    const maxDetected = Math.max(...detectedScores);
    await deps.db.persistOutcome({
      userId,
      sessionId,
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
    // Type Radar candidate tagging (§Type Radar, step 6): an isolated vision
    // pass, independent of the Elo seed above. Best-effort and flag-gated at the
    // dep level; a failure only leaves `V_type` neutral for this candidate.
    if (deps.tagAppearance && photos.length > 0) {
      try {
        await deps.tagAppearance(userId, photos, user.gender);
      } catch (err) {
        console.warn(`${LOG_PREFIX} appearance tagging threw (swallowed)`, { userId, err });
      }
    }
    // Announce the pass — unless this run only re-confirmed a user who was
    // ALREADY verified. Photo edits auto-rerun the pipeline, so re-DMing the
    // success copy would repeat "you're verified, your profile is live" every
    // time an active user touches their photos. Nothing changed for them and
    // there is nothing to act on, so stay silent. (Same spirit as the
    // `statusMessageId` guard in `surfaceVerifiedActivationDefault`, which
    // already stops the menu + banner from being re-sent on a rerun.)
    if (options.previousVerificationStatus !== "verified") {
      await sendOutcomeMessage(deps, user.telegramId, "verified", user.language);
    }
    if (user.telegramId > 0n) {
      await surfaceVerifiedActivation(deps, {
        userId,
        telegramId: user.telegramId,
      });
    }
    // Referral settlement (§Referral): pay + DM the referrer if this invitee was
    // invited by a `referral:<id>` link. Best-effort; not gated on telegramId so
    // a mobile invitee still rewards their (possibly Telegram) referrer. The
    // reward itself is idempotent, so re-runs (admin recheck) never double-pay.
    if (deps.settleReferralReward) {
      try {
        await deps.settleReferralReward(userId);
      } catch (err) {
        console.warn(`${LOG_PREFIX} referral settle threw (swallowed)`, { userId, err });
      }
    }
    // Founder ops feed: first activation via a `verified` outcome. The vision
    // Elo seed above has run, so the DM'd profile carries the attractiveness
    // score. Idempotent + status-gated inside the notifier; fire-and-forget.
    void notifyFounderNewUser(userId).catch(() => {});
    return { kind: "verified", userId, score: maxDetected, scores };
  }

  // Borderline outcome: nothing failed but quorum wasn't met (e.g.
  // every photo landed in [REVIEW, VERIFY)). Hand to admin.
  const avgDetected =
    detectedScores.reduce((a, b) => a + b, 0) / detectedScores.length;
  console.warn(`${LOG_PREFIX} borderline → pending_review`, {
    userId,
    sessionId,
    passCount,
    minVerifiedPhotos: config.minVerifiedPhotos,
    avgDetected,
    scores,
    kinds,
  });
  await deps.db.persistOutcome({
    userId,
    sessionId,
    verificationStatus: "pending_review",
    faceMatchScore: avgDetected,
    photoFaceScores: scores,
    photosSnapshot,
    verifiedSelfiePath,
    shouldActivate: false,
  });
  await sendOutcomeMessage(deps, user.telegramId, "pending_review", user.language);
  return {
    kind: "pending_review",
    userId,
    reason: "borderline_score",
    score: avgDetected,
    scores,
  };
}

/**
 * Send the terminal-outcome DM in the user's own language. The copy lives in
 * shared i18n (`verifyOutcome*`) — it used to be hardcoded English here, which
 * meant a Russian-speaking user whose photos were rejected got an English wall
 * of text pointing at a Settings entry that no longer exists.
 */
async function sendOutcomeMessage(
  deps: Pick<PipelineDeps, "notify">,
  telegramId: bigint,
  kind: TerminalVerificationStatus,
  language: Language | null,
): Promise<void> {
  if (telegramId <= 0n) return; // mobile-only user — no Telegram chat to DM
  try {
    await deps.notify(
      telegramId,
      terminalVerificationMessage(language ?? "en", kind),
      kind,
    );
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

export interface DefaultPipelineOptions extends PipelineRunOptions {
  /**
   * Bytes AWS Face Liveness just returned. Present ONLY on a fresh check —
   * the liveness session (and this image with it) expires 3 minutes after it
   * was created, so the route that read it must pass it straight through.
   * Absent on every rerun, which reads the stored copy instead.
   */
  capturedSelfie?: CapturedSelfie;
}

/**
 * Production wiring: builds default deps from the bot's `Api` + the real
 * services and runs the pipeline. Called by the verification routes right
 * after a liveness pass, by the admin "rerun" button, and by
 * `triggerVerificationRerun` on every profile-photo edit.
 */
export async function runFaceMatchVerificationDefault(
  userId: string,
  sessionId: string,
  api: Api<RawApi>,
  options: DefaultPipelineOptions = {},
): Promise<VerificationOutcome> {
  return runFaceMatchVerification(
    userId,
    sessionId,
    {
      fetchReferenceSelfie: options.capturedSelfie
        ? capturedSelfieSource(options.capturedSelfie)
        : storedSelfieSource(userId),
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
      // Type Radar candidate tagging — its own isolated vision pass, gated by
      // TYPE_RADAR_ENABLED (dark by default → no dep, no OpenAI call). The
      // default helper re-checks the flag, so this is belt-and-suspenders.
      ...(env.TYPE_RADAR_ENABLED
        ? {
            tagAppearance: (uid: string, photos: readonly string[], gender: string | null) =>
              tagAndPersistAppearanceDefault(uid, photos, gender, api),
          }
        : {}),
      notify: async (telegramId, message, kind) => {
        // A rejection is the one outcome the user can act on, so it carries the
        // two recoveries inline instead of sending them hunting through menus:
        // swap the photos (the pipeline then re-scores them against the selfie
        // already on file) or re-run the liveness check.
        const keyboard =
          kind === "rejected"
            ? await buildVerificationKeyboard(
                (await prisma.user.findUnique({
                  where: { id: userId },
                  select: { language: true },
                }))?.language ?? "en",
                userId,
              )
            : null;
        await api.sendMessage(Number(telegramId), message, {
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
      },
      surfaceVerifiedActivation: async (input) => {
        await surfaceVerifiedActivationDefault(api, input.userId, input.telegramId);
      },
      ...(env.REFERRAL_FEATURE_ENABLED
        ? {
            settleReferralReward: (uid: string) => settleReferralOnVerified(uid, api),
          }
        : {}),
      db: {
        findUser: async (id) => {
          return prisma.user.findUnique({
            where: { id },
            select: {
              id: true,
              telegramId: true,
              status: true,
              gender: true,
              language: true,
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
                personaInquiryId: input.sessionId,
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
                  personaInquiryId: input.sessionId,
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
                personaInquiryId: input.sessionId,
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
                  sessionId: input.sessionId,
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
    options,
  );
}

/**
 * Re-trigger the face-match pipeline for a user whose profile photos just
 * changed. Fire-and-forget by design: the photo-edit handlers don't block on
 * Rekognition latency, but the user's verification state must eventually
 * reconcile with the new photo set.
 *
 * Behaviour:
 *   - No `personaInquiryId` (never ran a liveness check) → no-op; there is no
 *     reference selfie to compare against.
 *   - No `verifiedSelfiePath` → `reference_expired`. The 90-day GDPR scrub
 *     already removed the reference and AWS cannot re-issue it (a liveness
 *     session dies after 3 minutes), so the only way forward is one more
 *     liveness check. Critically, this returns BEFORE the `pending` flip
 *     below: a rerun we cannot complete must not knock a `verified` user out
 *     of the match pool over a photo they deleted.
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
  | { kind: "reference_expired" }
  | { kind: "started"; sessionId: string };

export async function triggerVerificationRerun(
  userId: string,
  api: Api<RawApi>,
): Promise<RerunOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      personaInquiryId: true,
      verificationStatus: true,
      verifiedSelfiePath: true,
    },
  });
  if (!user) return { kind: "user_missing" };
  if (!user.personaInquiryId) return { kind: "no_inquiry" };
  if (!user.verifiedSelfiePath) return { kind: "reference_expired" };

  // Captured BEFORE the `pending` flip below, which would otherwise erase it.
  // Lets the pipeline stay silent when the rerun just re-confirms an
  // already-verified user (see `PipelineRunOptions`).
  const previousVerificationStatus = user.verificationStatus;

  // Reset the idempotency marker AND flip status to `pending` so the
  // user sees we're re-checking. We pin the WHERE on `personaInquiryId`
  // to avoid racing with a concurrent liveness check that just moved them
  // to a newer session.
  await prisma.user.updateMany({
    where: { id: userId, personaInquiryId: user.personaInquiryId },
    data: { faceMatchedAt: null, verificationStatus: "pending" },
  });

  const sessionId = user.personaInquiryId;
  // Fire-and-forget; do not await. Errors land in the bot logs.
  void runFaceMatchVerificationDefault(userId, sessionId, api, {
    previousVerificationStatus,
  }).catch((err) => {
    console.error("[verification-pipeline] rerun failed", { userId, sessionId, err });
  });

  return { kind: "started", sessionId };
}
