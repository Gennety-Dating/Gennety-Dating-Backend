import { InlineKeyboard, type Api, type RawApi } from "grammy";
import { Prisma, prisma } from "@gennety/db";
import {
  MIN_PHOTOS,
  VERIFICATION_PHOTO_RACE_MAX_ATTEMPTS,
  t,
  type Language,
} from "@gennety/shared";
import { env } from "../config.js";
import { sendMainMenu } from "../handlers/menu/main.js";
import { seedEloFromVisionDefault, type SeedEloResult } from "./elo-seed.js";
import { tagAndPersistAppearanceDefault } from "./appearance-tags.js";
import { compareFaces } from "./face-match.js";
import { hasTrackVerifiedContact } from "./contact-verification.js";
import {
  capturedSelfieSource,
  storedSelfieSource,
  type CapturedSelfie,
  type ReferenceSelfieResult,
} from "./identity-selfie.js";
import { pinStatusBanner } from "./status-banner.js";
import { downloadProfileImage, uploadSelfie } from "./storage.js";
import type { OutcomeGate } from "./outcome-gate.js";
import { notifyFounderNewUser } from "./founder-notify.js";
import { settleReferralOnVerified } from "./referral-notify.js";
import { settleEventApplicationsOnVerified } from "./event-admission.js";
import {
  terminalVerificationMessage,
  terminalVerificationPush,
  verificationPhotosDroppedPush,
  verificationPhotosNeededPush,
  verificationRetryMessage,
  verificationRetryPush,
  type PushCopy,
} from "./verification-messages.js";
import { pushReachable, telegramReachable } from "./telegram-reach.js";
import { sendPushToUser, type PushPayload } from "./push.js";
import {
  buildVerificationKeyboard,
  VERIFY_PHOTOS_CALLBACK,
} from "./verification-keyboard.js";
import { alignPhotoHashes } from "./profile-media-validation/photo-state.js";

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
 *   - `verified`        — `pass` count ≥ FACE_MATCH_MIN_VERIFIED_PHOTOS.
 *                         The account holder is provably in the photo set.
 *                         Any `fail` photos are REMOVED from the profile
 *                         (`db.dropMismatchedPhotos`) instead of counting
 *                         against the account.
 *   - `rejected`        — a `fail` photo AND no pass quorum. Nothing in the
 *                         set identifies this person, while something in it
 *                         is a different person's face. Hard reject.
 *   - `pending_review`  — anything else (all-borderline, mixed pass+borderline
 *                         under quorum, zero detected faces).
 *
 * The `verified` branch's photo-dropping REPLACED an "any fail hard-rejects"
 * rule on 2026-07-27. That rule made a single weak score fatal to an account
 * that also carried solid matches, and its blast radius reached all the way
 * back into upload: the photo gate had to pre-emptively bounce anything that
 * might score low (a covered face, a hand near the mouth), which a production
 * audit found was ~82% of all upload friction — the largest single source of
 * registration drop-off, protecting against a threat the drop now handles
 * proportionately. The anti-impostor property is intact in both directions:
 * a set with no genuine match still rejects, and a planted photo never
 * survives on the profile either way. What changed is only WHO pays for one
 * bad photo — that photo, rather than the whole account.
 *
 * The quorum also excludes uninformative shots (no_face) from scoring, so a
 * group photo or scenery shot never tanks a profile where the solo photos
 * matched cleanly.
 *
 * Infrastructure failures never come out as `rejected` — we don't penalise
 * users for our own outages — and they never come out as `pending_review`
 * either: every one of them is `retry_required` (see `RetryReason`). That
 * covers a missing reference selfie, a reference frame with no face in it, a
 * photo that would not download, a Rekognition error, and a profile with no
 * photos at all. They used to split — only the missing selfie was retryable,
 * the rest went to `pending_review` "for an admin to look at" — which stranded
 * users (audit A13-H11): that status has no button, the re-engagement stall
 * sweep skips it, and the app gate keeps them locked, so nothing in the product
 * could move them, and a zero-photo run even nulled their stored selfie on the
 * way in. An admin rerun of such a run would only repeat our own outage; what
 * actually moves the user is running the check again, which the retry nudge
 * offers. `pending_review` is now reserved for what a human can genuinely
 * adjudicate: detected faces whose scores sit between the two thresholds, or a
 * photo set with no detected face at all (PRODUCT_SPEC §1.4 rule 3).
 *
 * A verdict is also only ever written for the photo set it scored (audit
 * A13-H12). `persistOutcome` takes the same per-user row lock as every photo
 * upload and delete, re-reads `Profile.photos`, and refuses the write when
 * they moved; the run then re-scores the current set with the reference it
 * already holds, bounded by `VERIFICATION_PHOTO_RACE_MAX_ATTEMPTS`.
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

/**
 * What a human reviewer is asked to adjudicate. Only outcomes that carry real
 * evidence about the photo set belong here — see `RetryReason` for everything
 * that is merely our side failing to produce a verdict.
 */
export type PendingReviewReason =
  /** Detected faces scored in [thresholdReview, thresholdVerify) without a pass quorum. */
  | "borderline_score"
  /** Every photo scored `no_face` — group shots or scenery, nothing to compare. */
  | "no_detected_faces";

/**
 * Why the run could not reach a verdict at all.
 *
 * Deliberately NOT `PendingReviewReason`. `pending_review` means "an admin
 * adjudicates a borderline score", and it is a dead end for the user by
 * design: no button, no retry, and `re-engagement.ts` skips it. Routing our
 * own storage, Rekognition or retention failures there stranded users behind a
 * card that only repeated "we're double-checking your photos" forever, with
 * nothing in the product able to move them (audit A13-H11). None of these is a
 * verdict about the user — each is retryable, exactly like a shaky liveness
 * capture (PRODUCT_SPEC §1.4).
 */
export type RetryReason =
  /** Storage had the object but it didn't come back. Transient, our side. */
  | "selfie_fetch_failed"
  /** No reference selfie at all (90-day GDPR scrub ran, or one was never
   *  stored). AWS cannot re-issue it — a liveness session dies after 3
   *  minutes — so the only way forward is one more liveness check. */
  | "reference_expired"
  /** The profile has no photos to compare the selfie against. Photos were
   *  removed after the check started (`beginLivenessCheck` refuses to start
   *  one without them), or a rerun followed a delete-everything redo. */
  | "no_profile_photos"
  /** The reference frame itself carries no detectable face, so no photo can
   *  be compared against it. Rerunning on the same frame changes nothing; a
   *  new liveness check produces a new one. */
  | "no_source_face"
  /** A profile photo would not download. Transient, our side. */
  | "photo_download_failed"
  /** Rekognition answered with an error or timed out. Transient, our side. */
  | "comparison_error"
  /** The photo set kept changing under every re-score attempt
   *  (`VERIFICATION_PHOTO_RACE_MAX_ATTEMPTS`). */
  | "photos_changed_during_run";

/**
 * `score` is the **representative** face-match score (0..1) that drove the
 * decision, NOT necessarily the min across photos:
 *   - verified       → highest pass score (most confident match)
 *   - rejected       → lowest detected-face score (the worst offender)
 *   - pending_review → average across detected-face photos (absent when no
 *                      photo carried a detected face)
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
  | { kind: "rejected"; userId: string; score: number; scores: number[] }
  | {
      kind: "retry_required";
      userId: string;
      reason: RetryReason;
      /**
       * True when the user was already `verified` going into this run and we
       * left them that way. Our own outage must never demote someone out of
       * the match pool — see the branch that raises this outcome.
       */
      keptVerified: boolean;
    };

export type TerminalVerificationStatus = "verified" | "pending_review" | "rejected";

/**
 * What `persistRetryable` writes: either the user's pre-run status restored
 * (`verified`) or the retryable gate state they can act on.
 */
export type RetryableVerificationStatus = "verified" | "pending";

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
   * DM the user with the outcome. Callers gate on `telegramReachable` before
   * reaching this — it is never invoked for an account the bot cannot message.
   * `message` is already localized to the user's language; `kind` is passed so
   * the production wiring can attach the right affordances without re-deriving
   * them from the copy (a `rejected` or `retry` DM carries the verify /
   * re-upload buttons).
   */
  notify: (
    telegramId: bigint,
    message: string,
    kind: TerminalVerificationStatus | "retry" | "photos_needed",
  ) => Promise<void>;
  /**
   * Push the same outcome to the native app. The second half of the answer to
   * "who hears about this run": `notify` covers the Telegram rail, this one
   * covers `mobile` / `both`, and the two gates are independent — a `both`
   * account gets told twice, once on each surface.
   *
   * Optional so tests and any non-push wiring can omit it; when absent the app
   * rail is simply skipped, which is what shipped before this dep existed and
   * is exactly the defect it removes. Resolves `false` rather than throwing on
   * a dead token or an unconfigured APNs.
   */
  sendPush?: (userId: string, payload: PushPayload) => Promise<boolean>;
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
   * Launch-event admission (LAUNCH_EVENTS_PRODUCT_SPEC.md §4): tier any event
   * application this freshly-verified user holds, and auto-apply them to an
   * event that asked for it. Optional + best-effort, exactly like
   * `settleReferralReward` above — a failure never blocks verification.
   *
   * This is the ONLY place admission tiering happens automatically, and that
   * is deliberate: the admission condition is a verified profile, so a hook at
   * onboarding completion would put unverifiable accounts into a founder's
   * moderation queue. No-ops when the feature flag is off.
   */
  settleEventAdmission?: (userId: string) => Promise<void>;
  /**
   * DB shim so tests can hand in an in-memory store. Production uses the
   * real Prisma client. Only the slices we actually call.
   */
  db: {
    findUser: (userId: string) => Promise<PipelineUserRow | null>;
    /**
     * Write a verdict — but only for the photo set it was computed from.
     *
     * MUST run under the same per-user row lock the photo upload and delete
     * paths take, re-read `Profile.photos` inside it, and answer
     * `photos_changed` without writing anything when they no longer equal
     * `photosSnapshot` (audit A13-H12). Checking outside the lock is not
     * enough: an upload committing between the check and the write would
     * leave an unscored photo on a freshly activated profile.
     */
    persistOutcome: (input: PersistOutcomeInput) => Promise<PersistOutcomeResult>;
    /**
     * Write the outcome of a run that never reached a verdict. Deliberately
     * narrower than `persistOutcome`: it touches `verificationStatus` and the
     * idempotency marker, plus — only when `reference` is given — the session
     * and selfie that run stored. It never writes `faceMatchScore` or
     * per-photo scores, and never clears a stored selfie: there is nothing new
     * to say about either.
     */
    persistRetryable: (input: PersistRetryableInput) => Promise<void>;
    /**
     * Remove the photos at `dropIndexes` from the profile after a `verified`
     * outcome, keeping `photos` / `photoFaceScores` / `uploadedPhotoHashes` /
     * `profileMedia` aligned. Returns how many were actually removed (0 when
     * the guard below declines).
     *
     * This is what lets a mismatching photo cost the user that photo instead
     * of their whole account (§1.4). Optional so tests and mobile-only paths
     * can omit it; when absent the photo simply stays, which is the same
     * behaviour as a failed drop.
     *
     * MUST be snapshot-gated: apply only while `Profile.photos` still equals
     * `photosSnapshot`, so a photo edit that landed mid-run makes this a no-op
     * rather than deleting by a stale index.
     */
    dropMismatchedPhotos?: (input: {
      userId: string;
      photosSnapshot: string[];
      dropIndexes: number[];
    }) => Promise<number>;
  };
}

export interface PersistRetryableInput {
  userId: string;
  /**
   * `verified` restores a user our outage would otherwise have demoted;
   * `pending` is the retryable gate state, which the verification card and the
   * re-engagement stall sweep both know how to act on.
   */
  verificationStatus: RetryableVerificationStatus;
  /**
   * Always cleared. The spent session produced no usable reference, so the
   * `(personaInquiryId, faceMatchedAt)` idempotency guard must not treat this
   * run as a completed decision — otherwise a retry with the same session id
   * silently no-ops.
   */
  clearFaceMatchedAt: true;
  /**
   * The liveness session and the selfie this run uploaded, when it uploaded
   * one. Recording them is what lets the user's next photo edit rerun against
   * this selfie: `triggerVerificationRerun` answers `no_inquiry` for a row with
   * no session — which is exactly the state a FIRST check is in until its
   * verdict lands, so without this a photo uploaded mid-run was never scored.
   *
   * Only ever passed for a user who was not verified going into the run. For a
   * verified user an unmatched selfie would become the reference the per-photo
   * upload gate trusts, before any face-match had tied it to their photos.
   */
  reference?: { sessionId: string; verifiedSelfiePath: string };
}

/**
 * What `persistOutcome` did. `photos_changed` means nothing was written: the
 * profile photos no longer equal the snapshot the verdict was computed from.
 */
export type PersistOutcomeResult = { kind: "persisted" } | { kind: "photos_changed" };

export interface PipelineUserRow {
  id: string;
  telegramId: bigint;
  /**
   * Which rails this account actually has (`telegram` | `mobile` | `both`).
   * The reachability test, NOT `telegramId > 0n` — "Continue with Telegram"
   * stores a real positive id on an app-only account the bot cannot open a
   * chat with. See `telegram-reach.ts`; null means a row predating the column,
   * which the helper reads as Telegram.
   */
  platform: string | null;
  status: string;
  /**
   * Activation prerequisites (audit A13-M18). A face-match pass proves who the
   * person is, not that they finished registering: `status` flips to `active`
   * only for a completed onboarding with a verified track contact — the same
   * two conditions matching itself filters on.
   */
  onboardingStep: string;
  registrationTrack: string | null;
  email: string | null;
  isEmailVerified: boolean;
  phoneVerifiedAt: Date | null;
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
   * fires a rerun (menu photo manager, mobile `/v1/me/photos`, chat agent), so
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
   * Null when no photo carried a detected face. Runs that could not score at
   * all never reach this write — they go through `persistRetryable`.
   */
  faceMatchScore: number | null;
  /** Per-photo scores (parallel to Profile.photos). Empty array means "leave existing scores in place". */
  photoFaceScores: number[];
  /**
   * Snapshot of `Profile.photos` taken when scoring started. The whole write
   * is gated on the snapshot still matching DB state under the per-user lock —
   * if the user added or removed photos mid-run the verdict describes a set
   * that no longer exists, so nothing is written (`photos_changed`).
   */
  photosSnapshot: string[];
  /**
   * Selfie storage path (Supabase). Null when the upload failed; a null never
   * overwrites a path already on the row, which would strand the user on
   * `reference_expired` at their next photo edit.
   */
  verifiedSelfiePath: string | null;
  /**
   * `true` only on the verified branch when the pipeline found the account
   * ready for the pool — flips `User.status` from `onboarding` → `active`. The
   * persist re-checks `onboarding` + completed onboarding + track contact under
   * the lock, so admin-moderated states survive and a half-registered account
   * is never activated.
   */
  shouldActivate: boolean;
}

const LOG_PREFIX = "[verification-pipeline]";

/**
 * Why a verified outcome may not flip `status` to `active` (audit A13-M18).
 *
 * Asked only of an account still in `onboarding`: an active user is never
 * re-activated, and an admin-moderated one is never activated at all. Both
 * conditions are what matching itself filters on, so an account activated
 * without them would sit `active` yet unmatchable — while still collecting
 * what activation pays out (the referrer's reward, event admission). Neither
 * is reachable through a client today: `beginLivenessCheck` refuses a first
 * check before onboarding completes, and finishing onboarding requires the
 * track contact. This is the backstop for the edges those gates cannot see.
 */
export type ActivationBlocker = "onboarding_incomplete" | "contact_unverified";

export function activationBlockerFor(
  user: Pick<
    PipelineUserRow,
    "onboardingStep" | "registrationTrack" | "email" | "isEmailVerified" | "phoneVerifiedAt"
  >,
): ActivationBlocker | null {
  if (user.onboardingStep !== "completed") return "onboarding_incomplete";
  if (!hasTrackVerifiedContact(user)) return "contact_unverified";
  return null;
}

/** `scorePhotoSet`'s answer when its persist found the photo set had moved. */
const PHOTOS_CHANGED = Symbol("photos_changed");

/** Everything one scoring attempt needs that does not change between attempts. */
interface ScoringContext {
  userId: string;
  sessionId: string;
  deps: PipelineDeps;
  config: PipelineConfig;
  options: PipelineRunOptions;
  selfieBuffer: Buffer;
  verifiedSelfiePath: string | null;
  /**
   * Park the user in the retryable state and nudge them. `recordReference:
   * false` keeps the selfie this run stored off the row — for a frame that
   * cannot serve as a reference at all.
   */
  retry: (
    reason: RetryReason,
    options?: { recordReference: boolean },
  ) => Promise<VerificationOutcome>;
}

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

  // `triggerVerificationRerun` flips the row to `pending` BEFORE launching
  // us, so the row's own status no longer tells us what the user was — hence
  // the pre-run status carried in options. A verified user whose photo edit
  // happened to race our own outage must stay verified and stay in the match
  // pool; only someone who was never verified gets moved to the gate.
  const statusBeforeRun = options.previousVerificationStatus ?? user.verificationStatus;
  const keptVerified = statusBeforeRun === "verified";

  // Every no-verdict exit goes through these two, so they all agree on what a
  // retryable state is: `pending` (or `verified` restored), the idempotency
  // marker cleared, and — once this run has stored a selfie for a user who is
  // not verified yet — that reference recorded, so their next photo edit can
  // rerun against it instead of starting over.
  let recordedReference: PersistRetryableInput["reference"];
  const parkRetryable = async (recordReference: boolean): Promise<void> => {
    await deps.db.persistRetryable({
      userId,
      verificationStatus: keptVerified ? "verified" : "pending",
      clearFaceMatchedAt: true,
      ...(recordReference && recordedReference ? { reference: recordedReference } : {}),
    });
  };
  const retry: ScoringContext["retry"] = async (reason, retryOptions) => {
    await parkRetryable(retryOptions?.recordReference ?? true);
    // Nudge only the user who actually has something to do. Telling a verified
    // user to re-verify because our side hiccuped would be noise; when their
    // reference is genuinely gone, the photo-edit handler already asks them
    // once per upload burst via `triggerVerificationRerun`'s pre-check.
    if (!keptVerified) {
      await sendRetryMessage(deps, user);
    }
    return { kind: "retry_required", userId, reason, keptVerified };
  };

  // Nothing to compare the selfie against. `beginLivenessCheck` refuses to
  // start a check on a profile without photos, so reaching this means they
  // went away after the check started — or a rerun followed a delete-all redo.
  // This used to write `pending_review` AND null the stored selfie: a dead end
  // twice over (audit A13-H11), because that card has no button and the next
  // photo upload then answered `reference_expired`. Retryable instead, and the
  // selfie on file stays where it is, so adding photos reruns against it.
  if ((user.profile?.photos ?? []).length === 0) {
    console.warn(`${LOG_PREFIX} no profile photos to compare`, { userId, sessionId });
    return retry("no_profile_photos");
  }

  // Step 1: resolve the reference selfie (fresh liveness capture, or the
  // stored copy on a rerun — see `identity-selfie.ts`).
  const selfieResult = await deps.fetchReferenceSelfie();
  if (!selfieResult.ok) {
    // No reference selfie → no verdict is possible. This is OUR failure
    // (storage blip, or the retention scrub already ran), never a statement
    // about the user, so it must not land in `pending_review`: that state is
    // for an admin to adjudicate a borderline score, it carries no button, and
    // the re-engagement stall sweep skips it — a user routed there is stuck
    // forever behind "we're double-checking your photos" with nothing in the
    // product able to move them. Retryable instead (PRODUCT_SPEC §1.4).
    console.error(`${LOG_PREFIX} reference selfie unavailable`, {
      userId,
      sessionId,
      error: selfieResult.error,
    });
    return retry(
      selfieResult.error === "reference_expired" ? "reference_expired" : "selfie_fetch_failed",
    );
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
    // Only a selfie THIS run uploaded is news to the row (a rerun's path is
    // already there), and only for a user who is not verified yet — see
    // `PersistRetryableInput.reference`.
    if (verifiedSelfiePath && !keptVerified) {
      recordedReference = { sessionId, verifiedSelfiePath };
    }
  }

  const context: ScoringContext = {
    userId,
    sessionId,
    deps,
    config,
    options,
    selfieBuffer,
    verifiedSelfiePath,
    retry,
  };

  // Score — and score again whenever the persist finds the photo set moved
  // under us (audit A13-H12), with the selfie already in memory, so a photo
  // edit mid-run never costs the user a second liveness check.
  let current = user;
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await scorePhotoSet(context, current);
    if (outcome !== PHOTOS_CHANGED) return outcome;

    console.warn(`${LOG_PREFIX} photos changed during run — verdict discarded`, {
      userId,
      sessionId,
      attempt,
    });
    if (attempt >= VERIFICATION_PHOTO_RACE_MAX_ATTEMPTS) {
      return retry("photos_changed_during_run");
    }

    // Park in the retryable state BEFORE re-scoring, carrying the reference
    // just stored. A first check has no session on the row until a verdict
    // lands, so a photo edit arriving during the re-score would otherwise get
    // `no_inquiry` from `triggerVerificationRerun` and never be looked at.
    await parkRetryable(true);

    const reread = await deps.db.findUser(userId);
    if (!reread) return { kind: "skipped_user_missing", userId };
    // A photo-edit rerun started from the reference parked above may already
    // have decided this session on the newer set. That verdict stands.
    if (reread.personaInquiryId === sessionId && reread.faceMatchedAt !== null) {
      return { kind: "skipped_idempotent", userId };
    }
    if ((reread.profile?.photos ?? []).length === 0) {
      return retry("no_profile_photos");
    }
    current = reread;
  }
}

/**
 * One scoring attempt over the photo set `user` carries: compare every photo
 * with the reference, decide, persist, announce. Answers `PHOTOS_CHANGED`
 * (having written and announced nothing) when the persist found the profile
 * photos no longer equal the set that was scored.
 */
async function scorePhotoSet(
  context: ScoringContext,
  user: PipelineUserRow,
): Promise<VerificationOutcome | typeof PHOTOS_CHANGED> {
  const { userId, sessionId, deps, config, options, selfieBuffer, verifiedSelfiePath } = context;

  // Snapshot the photos this verdict will describe. `persistOutcome` compares
  // it with the row under the per-user lock that photo uploads and deletes
  // take, and writes nothing when they differ — so a photo edit landing while
  // we score can never inherit a verdict it did not earn.
  const photos = user.profile?.photos ?? [];
  const photosSnapshot = [...photos];

  // Step 3: download profile photos and compare each against the selfie.
  // We track per-photo *kind* alongside the numeric score because the
  // decision rule (Step 4) ignores no-face photos rather than treating
  // them as hard 0 — old behavior was a footgun for users with one
  // group shot in their album.
  type PhotoKind = "scored" | "no_face";
  const scores: number[] = [];
  const kinds: PhotoKind[] = [];
  let infraError: Extract<RetryReason, "photo_download_failed" | "comparison_error"> | null =
    null;
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
        // detectable face. Not the user's fault, and not something an admin
        // can fix either — a rerun reads the same frame.
        console.error(`${LOG_PREFIX} no_source_face on reference selfie`, {
          userId,
          sessionId,
        });
        sourceFaceMissing = true;
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
    // Retryable (audit A13-H11): a new liveness check produces a new frame,
    // which is the one thing that moves this user. The faceless frame is kept
    // off the row — as a reference it could only repeat this outcome on every
    // later photo edit.
    return context.retry("no_source_face", { recordReference: false });
  }

  if (infraError) {
    // Our side failed mid-scoring. Partial scores with zeros for the photos we
    // could not read are not a verdict, so they are neither persisted as one
    // nor handed to an admin to adjudicate (audit A13-H11) — the failing photo
    // is in the log line above. Running the check again is what moves the user.
    return context.retry(infraError);
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
    const persisted = await deps.db.persistOutcome({
      userId,
      sessionId,
      verificationStatus: "pending_review",
      faceMatchScore: null,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    if (persisted.kind === "photos_changed") return PHOTOS_CHANGED;
    await sendOutcomeMessage(deps, user, "pending_review");
    return {
      kind: "pending_review",
      userId,
      reason: "no_detected_faces",
      scores,
    };
  }

  // Indexes (into `photosSnapshot`) of the photos that carry a detected face
  // scoring below `thresholdReview` — a wrong-person / impostor shot.
  const failedIndexes = scores.reduce<number[]>((acc, score, index) => {
    if (kinds[index] === "scored" && score < config.thresholdReview) {
      acc.push(index);
    }
    return acc;
  }, []);

  if (failCount > 0 && passCount < config.minVerifiedPhotos) {
    // A mismatching face AND nothing that proves the account holder is in the
    // photo set at all. Nothing here identifies this person, so hard reject.
    //
    // Narrowed 2026-07-27: this used to fire on `failCount > 0` alone, so ONE
    // weak photo destroyed an account that also carried solid matches. That is
    // what forced the upload-time obstruction gate to over-reject (a covered
    // face can score low), which in turn was ~82% of all upload friction. When
    // a pass quorum exists we now keep the account and drop the offending
    // photo instead — see the verified branch below. The anti-impostor
    // property is preserved in both directions: a set with no genuine match
    // still lands here, and a planted photo never survives on the profile.
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
    const persisted = await deps.db.persistOutcome({
      userId,
      sessionId,
      verificationStatus: "rejected",
      faceMatchScore: minDetected,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: false,
    });
    if (persisted.kind === "photos_changed") return PHOTOS_CHANGED;
    await sendOutcomeMessage(deps, user, "rejected");
    return { kind: "rejected", userId, score: minDetected, scores };
  }

  if (passCount >= config.minVerifiedPhotos) {
    // Quorum cleared — the account holder is provably in the photo set, so
    // approve. Any individual photo that did NOT match is dropped from the
    // profile rather than held against the account (see the reject branch).
    const maxDetected = Math.max(...detectedScores);

    // Activation is conditional on the profile still clearing `MIN_PHOTOS`
    // AFTER the mismatching photos come off. Dropping photos must not be a
    // back door into the matching pool with a half-empty profile: every other
    // surface (menu photo manager, mobile `/v1/me/photos`) enforces the same
    // floor on a live profile, and matching has no photo-count filter of its
    // own to catch it.
    //
    // The count is PREDICTED from the snapshot because ordering is forced: the
    // persist is gated on `photos` still equalling `photosSnapshot`, so it has
    // to run before the drop rewrites that array — and that same gate is what
    // makes the snapshot count the real count at the moment of activation. If
    // the drop then no-ops (an edit landed between the two writes), that
    // edit's own auto-rerun — which finds this session on the row now —
    // re-decides on the fresh set moments later.
    const projectedPhotoCount = photos.length - failedIndexes.length;
    const meetsPhotoMinimum = projectedPhotoCount >= MIN_PHOTOS;
    const activationBlocker =
      user.status === "onboarding" ? activationBlockerFor(user) : null;

    const persisted = await deps.db.persistOutcome({
      userId,
      sessionId,
      verificationStatus: "verified",
      faceMatchScore: maxDetected,
      photoFaceScores: scores,
      photosSnapshot,
      verifiedSelfiePath,
      shouldActivate: meetsPhotoMinimum && activationBlocker === null,
    });
    if (persisted.kind === "photos_changed") return PHOTOS_CHANGED;

    // Drop the mismatching photos. Best-effort ON PURPOSE: the user is already
    // committed as verified above, so a storage/DB hiccup here must leave the
    // photo in place rather than unwind an approval. The drop is snapshot-gated
    // inside the dep, so a concurrent photo edit makes it a no-op instead of
    // corrupting the photos[i] ↔ photoFaceScores[i] alignment; the edit's own
    // auto-rerun then re-decides on the fresh set.
    let droppedCount = 0;
    if (failedIndexes.length > 0 && deps.db.dropMismatchedPhotos) {
      try {
        droppedCount = await deps.db.dropMismatchedPhotos({
          userId,
          photosSnapshot,
          dropIndexes: failedIndexes,
        });
      } catch (err) {
        console.warn(`${LOG_PREFIX} mismatched-photo drop threw (swallowed)`, {
          userId,
          err,
        });
      }
    }

    if (activationBlocker) {
      // Verified — that is permanent — but not activated, and nothing that
      // activation carries happens either: no "your profile is live" copy that
      // would be false, no referrer reward, no event admission, no founder
      // feed (audit A13-M18). Loud, because no client flow should reach it.
      console.error(`${LOG_PREFIX} verified but not activated — account not ready for the pool`, {
        userId,
        sessionId,
        blocker: activationBlocker,
      });
      return { kind: "verified", userId, score: maxDetected, scores };
    }

    const keptPhotos =
      droppedCount > 0
        ? photos.filter((_, index) => !failedIndexes.includes(index))
        : photos;
    // Cold-start Elo seed runs only here, after the user is committed as
    // verified. Idempotency guard: skip if a previous run already seeded
    // (e.g. an admin rerun on the same already-verified user). Wrapped in
    // try/catch so a vision/Supabase outage never demotes a verified user.
    //
    // Deliberately also skipped while the profile is under `MIN_PHOTOS`: the
    // seed is once-only, and seeding attractiveness off a single surviving
    // photo would permanently miscalibrate this user's league. The rerun that
    // fires when they finish adding photos seeds off the complete set instead.
    if (
      meetsPhotoMinimum &&
      deps.seedEloFromVision &&
      user.profile &&
      user.profile.eloSeededAt === null &&
      keptPhotos.length > 0
    ) {
      try {
        const seed = await deps.seedEloFromVision(userId, keptPhotos);
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
    if (meetsPhotoMinimum && deps.tagAppearance && keptPhotos.length > 0) {
      try {
        await deps.tagAppearance(userId, keptPhotos, user.gender);
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
    if (!meetsPhotoMinimum) {
      // Verified, but held out of the pool until the profile is refilled. This
      // is ONE message, not "verified ✨" followed by a correction: the user
      // needs the outcome and the ask together, or the success copy reads as
      // "you're live" when they are not. It always sends, including on a
      // re-confirm rerun — the photo count is what changed, and it is the only
      // thing standing between them and matching.
      const need = MIN_PHOTOS - projectedPhotoCount;
      await announce(deps, user, {
        dm: t(user.language ?? "en", "verifyPhotosBelowMinimum", {
          min: MIN_PHOTOS,
          need,
        }),
        dmKind: "photos_needed",
        push: verificationPhotosNeededPush(user.language ?? "en", {
          min: MIN_PHOTOS,
          need,
        }),
        status: "photos_needed",
      });
      // No menu, no pinned banner: `status` is still `onboarding`, so the
      // verification gate owns every surface until the photos are back.
      console.warn(`${LOG_PREFIX} verified but below photo minimum`, {
        userId,
        kept: projectedPhotoCount,
        min: MIN_PHOTOS,
        dropped: droppedCount,
      });
      return { kind: "verified", userId, score: maxDetected, scores };
    }

    if (options.previousVerificationStatus !== "verified") {
      await sendOutcomeMessage(deps, user, "verified");
    }
    // Say it out loud when the photo set shrank — including on a re-confirm
    // rerun that stays otherwise silent. Photos vanishing from a profile with
    // no explanation would be its own bug, and this is the user's cue to add
    // replacements.
    if (droppedCount > 0) {
      await announce(deps, user, {
        dm: t(user.language ?? "en", "verifyPhotosDropped"),
        // Not a DM kind of its own: this message asks for nothing, so it wants
        // no keyboard, and `verified` is the kind the wiring already reads that
        // way. The push side does distinguish it (`status: "photos_dropped"`),
        // because there the two are separate notifications on a lock screen.
        dmKind: "verified",
        push: verificationPhotosDroppedPush(user.language ?? "en"),
        status: "photos_dropped",
      });
    }
    // Same reachability question as the announcement above, same answer:
    // `telegramId > 0n` would send a main menu into a chat a Telegram-login app
    // user never opened. The surface itself keeps its own guards.
    if (telegramReachable(user)) {
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
    // Launch-event admission: the applicant is verified as of this branch, so
    // any application they hold can finally be tiered. Runs AFTER the Elo seed
    // above on purpose — the seed is what writes the score the `scored` policy
    // reads, and a tiering that ran first would see null and route a perfectly
    // scoreable applicant to a human for no reason.
    if (deps.settleEventAdmission) {
      try {
        await deps.settleEventAdmission(userId);
      } catch (err) {
        console.warn(`${LOG_PREFIX} event admission threw (swallowed)`, { userId, err });
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
  const persisted = await deps.db.persistOutcome({
    userId,
    sessionId,
    verificationStatus: "pending_review",
    faceMatchScore: avgDetected,
    photoFaceScores: scores,
    photosSnapshot,
    verifiedSelfiePath,
    shouldActivate: false,
  });
  if (persisted.kind === "photos_changed") return PHOTOS_CHANGED;
  await sendOutcomeMessage(deps, user, "pending_review");
  return {
    kind: "pending_review",
    userId,
    reason: "borderline_score",
    score: avgDetected,
    scores,
  };
}

/**
 * The single push type every verification announcement carries. One type, not
 * one per outcome: the tap destination is the same surface in all of them (the
 * verification state the app already renders), and each extra type is a route
 * the client has to learn before a notification becomes tappable at all — an
 * unrouted type opens nothing. Which outcome it was travels in `data.status`,
 * so the client can refine the destination later without a contract change.
 *
 * Deliberately NOT in `TIME_SENSITIVE_PUSH_TYPES` (`services/apns.ts`, a closed
 * set of two): a verification verdict is news, not an emergency, and piercing
 * Focus for it would be exactly the claim on someone's Do Not Disturb the
 * 2026-08-12 decision refused.
 */
export const VERIFICATION_PUSH_TYPE = "verification.outcome";

/** What `data.status` can say — one value per thing that actually happened. */
export type VerificationPushStatus =
  | TerminalVerificationStatus
  | "retry"
  | "photos_needed"
  | "photos_dropped";

/** The slice of the user row an announcement needs: who, where, in what language. */
type AnnounceTarget = Pick<PipelineUserRow, "id" | "telegramId" | "platform" | "language">;

interface Announcement {
  /** Already-localized DM body. */
  dm: string;
  /** Passed through to `notify` so the wiring can attach the right buttons. */
  dmKind: TerminalVerificationStatus | "retry" | "photos_needed";
  /** Lock-screen twin of `dm`. */
  push: PushCopy;
  /** Rides along in `data.status`. */
  status: VerificationPushStatus;
}

/**
 * Tell the user, on every rail they actually have.
 *
 * This function exists because the version it replaced asked the wrong
 * question. It gated on `telegramId > 0n`, which is not reachability: signing
 * in through "Continue with Telegram" stores a REAL positive id on an app-only
 * account, so the DM went out to a chat that was never opened and came back
 * `400: chat not found` — and there was no push rail at all. A `mobile` user
 * whose face-match was rejected therefore learned neither that it failed nor
 * that it passed, and sat on a screen whose only button re-runs liveness
 * against the same photos. Found by walking registration on a real iPhone,
 * 2026-08-23; the rule it breaks was already written down ninety lines below,
 * in `surfaceVerifiedActivationDefault`.
 *
 * The two gates are independent, not a fallback chain: `both` is two rails for
 * one event, and each leg swallows its own failure so a blocked Telegram chat
 * cannot take the push down with it (or the reverse).
 */
async function announce(
  deps: Pick<PipelineDeps, "notify" | "sendPush">,
  user: AnnounceTarget,
  announcement: Announcement,
): Promise<void> {
  const legs: Array<Promise<unknown>> = [];

  if (telegramReachable(user)) {
    legs.push(
      deps.notify(user.telegramId, announcement.dm, announcement.dmKind).catch((err: unknown) => {
        console.warn(`${LOG_PREFIX} outcome DM failed`, {
          userId: user.id,
          telegramId: String(user.telegramId),
          status: announcement.status,
          err,
        });
      }),
    );
  }

  if (deps.sendPush && pushReachable(user)) {
    legs.push(
      deps
        .sendPush(user.id, {
          title: announcement.push.title,
          body: announcement.push.body,
          data: { type: VERIFICATION_PUSH_TYPE, status: announcement.status },
        })
        .catch((err: unknown) => {
          console.warn(`${LOG_PREFIX} outcome push failed`, {
            userId: user.id,
            status: announcement.status,
            err,
          });
        }),
    );
  }

  await Promise.all(legs);
}

/**
 * Announce a terminal outcome in the user's own language. The copy lives in
 * shared i18n (`verifyOutcome*` for the DM, `verifyPush*` for the push) — it
 * used to be hardcoded English here, which meant a Russian-speaking user whose
 * photos were rejected got an English wall of text pointing at a Settings entry
 * that no longer exists.
 */
async function sendOutcomeMessage(
  deps: Pick<PipelineDeps, "notify" | "sendPush">,
  user: AnnounceTarget,
  kind: TerminalVerificationStatus,
): Promise<void> {
  const language = user.language ?? "en";
  await announce(deps, user, {
    dm: terminalVerificationMessage(language, kind),
    dmKind: kind,
    push: terminalVerificationPush(language, kind),
    status: kind,
  });
}

/**
 * Announce the "run the check" nudge for a run that could not reach a verdict.
 * Same copy and same affordances as the ordinary verification reminder — from
 * the user's side nothing happened yet, and the one thing that moves them
 * forward is starting a fresh liveness check.
 */
async function sendRetryMessage(
  deps: Pick<PipelineDeps, "notify" | "sendPush">,
  user: AnnounceTarget,
): Promise<void> {
  const language = user.language ?? "en";
  await announce(deps, user, {
    dm: verificationRetryMessage(language),
    dmKind: "retry",
    push: verificationRetryPush(language),
    status: "retry",
  });
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

/**
 * The visible landing sequence a freshly verified Telegram user gets: the
 * Profiler heads-up, the main menu, then the pinned status banner. Exported
 * only so that ordering and its `statusMessageId` / `platform` guards can be
 * pinned by a test — production reaches it through the `surfaceVerifiedActivation`
 * dep wired below, never by importing it.
 */
export async function surfaceVerifiedActivationDefault(
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
      platform: true,
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

  // Heads-up that the Profiler is about to start asking (PRODUCT_SPEC §Phase 1b).
  // Activation is the honest moment for it: the dispatch sweep filters on
  // `status = 'active'`, so this is exactly when the questions become possible
  // — and without a word here they arrive out of nowhere, days apart, with no
  // hint of who is asking or why answering matters.
  //
  // The `platform` gate mirrors `workers/profiler.ts` on purpose rather than
  // reusing the `telegramId > 0` check above: "Continue with Telegram" stores a
  // REAL positive id on an app-only account the bot cannot message, so that test
  // alone would promise questions this user is never asked. The copy is bound to
  // what the Profiler actually feeds — icebreakers and the pre-date wingman hint
  // — never to match quality, which it is deliberately no input to (§Phase 1b).
  if (user.platform === "telegram" || user.platform === "both") {
    try {
      await api.sendMessage(chatId, t(lang, "profilerHeadsUp"));
    } catch (err) {
      console.warn(`${LOG_PREFIX} profiler heads-up send failed`, {
        userId,
        telegramId: String(user.telegramId),
        err,
      });
    }
  }

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
 * The per-user row lock every profile-photo writer takes before its
 * read-modify-write (`identity-consensus.ts` upload and remove,
 * `DELETE /v1/me/photos`, `native-profile-video.ts`). The user row rather than
 * the profile row because it exists before any profile does, so even the very
 * first concurrent upload has something to queue on.
 */
async function lockUserRow(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRawUnsafe("SELECT id FROM users WHERE id = $1::uuid FOR UPDATE", userId);
}

/** Same refs in the same order — the order is what `photoFaceScores` is keyed by. */
function samePhotoSet(current: readonly string[], snapshot: readonly string[]): boolean {
  return (
    current.length === snapshot.length && current.every((ref, index) => ref === snapshot[index])
  );
}

export interface DefaultPipelineOptions extends PipelineRunOptions {
  /**
   * Bytes AWS Face Liveness just returned. Present ONLY on a fresh check —
   * the liveness session (and this image with it) expires 3 minutes after it
   * was created, so the route that read it must pass it straight through.
   * Absent on every rerun, which reads the stored copy instead.
   */
  capturedSelfie?: CapturedSelfie;
  /**
   * Hold every user-facing message until the caller's "analysing your check"
   * status has been torn down (`services/outcome-gate.ts`). Only the fresh
   * liveness path passes one, because it is the only caller that narrates the
   * run: without it the run's own speed decided the ordering, and a fast one
   * dropped the verdict on screen *underneath* a shimmer still claiming the
   * check was in progress. Absent on reruns and the admin recheck, where
   * nothing is narrated and messages go out immediately.
   */
  outcomeGate?: OutcomeGate;
  /**
   * Replace individual production dependencies, leaving the rest of the wiring
   * (notify, activation surface, Elo seed, DB access) exactly as built below.
   *
   * The only caller is demo mode (`demo/verification.ts`, DEMO_MODE.md), which
   * substitutes the four deps that carry identity *evidence* so a demo visitor
   * always passes. Scoped to those four on purpose: the decision itself, the
   * quorum rule, the photo-drop rule and the activation gate all still run for
   * real, so the demo exercises this pipeline rather than bypassing it.
   */
  depsOverride?: Partial<
    Pick<
      PipelineDeps,
      "fetchReferenceSelfie" | "uploadSelfie" | "downloadProfileImage" | "compareFaces"
    >
  >;
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
        // Wait for the caller's status shimmer to leave the screen (no-op when
        // nothing is narrating this run). This is the ONLY thing enforcing that
        // "we're finishing your check" is torn down before the verdict lands
        // in its place — the pipeline and the status run in parallel, so
        // without it the ordering was decided by whichever finished first.
        await options.outcomeGate?.hold();
        // `rejected` and `retry` are the outcomes the user can act on, so they
        // carry the recoveries inline instead of sending them hunting through
        // menus: swap the photos (the pipeline then re-scores them against the
        // selfie already on file) or re-run the liveness check. A `retry` DM
        // without the button would be the same dead end this branch exists to
        // remove — the verification gate is the only thing the user can reach.
        // `photos_needed` means verification already PASSED — there is nothing
        // to re-verify, so it gets the photo-manager button alone rather than
        // the Verify-first keyboard (which would invite a pointless second
        // liveness check).
        if (kind === "photos_needed") {
          await api.sendMessage(Number(telegramId), message, {
            reply_markup: new InlineKeyboard().text(
              t(
                (
                  await prisma.user.findUnique({
                    where: { id: userId },
                    select: { language: true },
                  })
                )?.language ?? "en",
                "verifyBtnRedoPhotos",
              ),
              VERIFY_PHOTOS_CALLBACK,
            ),
          });
          return;
        }
        const keyboard =
          kind === "rejected" || kind === "retry"
            ? await buildVerificationKeyboard(
                (await prisma.user.findUnique({
                  where: { id: userId },
                  select: { language: true },
                }))?.language ?? "en",
                userId,
                // `rejected` means a face WAS detected here and didn't match the
                // verification selfie, so "these aren't my photos" is the more
                // likely fix — lead with it. `retry` on this path is the infra
                // case (selfie fetch failed), where photos were never at fault
                // either way, so it keeps the default Verify-first order.
                kind === "rejected" ? { photoRedoFirst: true } : undefined,
              )
            : null;
        await api.sendMessage(Number(telegramId), message, {
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
      },
      // The app rail. Deliberately NOT held behind `options.outcomeGate` the way
      // `notify` is: that gate coordinates with a shimmer running in a Telegram
      // chat, and a push does not land there — a `both` user would just get the
      // lock-screen banner up to 30 s late for the sake of a symmetry that buys
      // nothing.
      sendPush: (uid: string, payload: PushPayload) => sendPushToUser(uid, payload),
      surfaceVerifiedActivation: async (input) => {
        // Same gate as `notify`: the menu + pinned banner are the landing the
        // user reads after the success DM, so they must not appear over a
        // status that is still running either.
        await options.outcomeGate?.hold();
        await surfaceVerifiedActivationDefault(api, input.userId, input.telegramId);
      },
      ...(env.REFERRAL_FEATURE_ENABLED
        ? {
            settleReferralReward: (uid: string) => settleReferralOnVerified(uid, api),
          }
        : {}),
      // Flag-gated the same way, and for the same reason: without a dep here
      // the verified branch never reaches the admission code at all, so the
      // subsystem is inert by construction rather than by a return statement
      // somebody has to remember. The helper re-checks the flag anyway.
      ...(env.EVENTS_FEATURE_ENABLED
        ? { settleEventAdmission: (uid: string) => settleEventApplicationsOnVerified(uid) }
        : {}),
      db: {
        findUser: async (id) => {
          return prisma.user.findUnique({
            where: { id },
            select: {
              id: true,
              telegramId: true,
              // The rail, not a decoration: `announce` reads it to decide who
              // hears about this run at all (`telegram-reach.ts`).
              platform: true,
              status: true,
              onboardingStep: true,
              registrationTrack: true,
              email: true,
              isEmailVerified: true,
              phoneVerifiedAt: true,
              gender: true,
              language: true,
              verificationStatus: true,
              personaInquiryId: true,
              faceMatchedAt: true,
              profile: { select: { photos: true, eloSeededAt: true } },
            },
          });
        },
        persistRetryable: async (input) => {
          // Narrow on purpose: status + idempotency marker, plus the session and
          // selfie this run stored when the pipeline hands them over.
          // `verifiedAt`, `faceMatchScore` and the per-photo scores keep
          // whatever they held — this run learned nothing about them — and a
          // stored selfie is never cleared here. Clearing `faceMatchedAt` is
          // what makes the state actually retryable: the guard at the top of
          // the pipeline keys on (personaInquiryId, faceMatchedAt), so leaving
          // it stamped would make the next attempt on the same session a
          // silent no-op.
          await prisma.user.update({
            where: { id: input.userId },
            data: {
              verificationStatus: input.verificationStatus,
              faceMatchedAt: null,
              ...(input.reference
                ? {
                    personaInquiryId: input.reference.sessionId,
                    verifiedSelfiePath: input.reference.verifiedSelfiePath,
                  }
                : {}),
            },
          });
        },
        dropMismatchedPhotos: async ({ userId, photosSnapshot, dropIndexes }) => {
          const drop = new Set(dropIndexes);
          if (drop.size === 0) return 0;
          const keep = (index: number): boolean => !drop.has(index);

          return await prisma.$transaction(async (tx) => {
            // The read-modify-write below rewrites four photo arrays wholesale,
            // so it must hold the lock every photo writer takes (audit
            // A13-L18). Without it an upload committing between this read and
            // the update was silently overwritten by the pre-upload arrays.
            await lockUserRow(tx, userId);
            const profile = await tx.profile.findUnique({
              where: { userId },
              select: {
                photos: true,
                photoFaceScores: true,
                uploadedPhotoHashes: true,
                profileMedia: true,
              },
            });
            if (!profile) return 0;

            // Snapshot guard — the indexes are only meaningful against the
            // photo array we scored. A photo edit that landed mid-run makes
            // this a no-op; that edit's own auto-rerun re-decides.
            if (!samePhotoSet(profile.photos, photosSnapshot)) return 0;

            // Never leave photos[i] ↔ photoFaceScores[i] misaligned. If the
            // score array is not already 1:1 we decline to touch anything —
            // losing the drop is recoverable, corrupting the alignment is not.
            if (profile.photoFaceScores.length !== profile.photos.length) {
              return 0;
            }

            const droppedRefs = new Set(
              profile.photos.filter((_, i) => !keep(i)),
            );
            const photos = profile.photos.filter((_, i) => keep(i));
            const photoFaceScores = profile.photoFaceScores.filter((_, i) =>
              keep(i),
            );
            const uploadedPhotoHashes = alignPhotoHashes(
              profile.photos,
              profile.uploadedPhotoHashes,
            ).filter((_, i) => keep(i));

            // `profileMedia` is keyed by photo ref, not by index: a video item
            // carries no `photo` and must survive untouched.
            const profileMedia = (
              Array.isArray(profile.profileMedia) ? profile.profileMedia : []
            ).filter((item) => {
              if (item === null || item === undefined) return false;
              if (typeof item !== "object" || Array.isArray(item)) return true;
              const ref = (item as Record<string, unknown>).photo;
              return typeof ref !== "string" || !droppedRefs.has(ref);
            }) as Prisma.InputJsonValue[];

            await tx.profile.update({
              where: { userId },
              data: {
                photos,
                photoFaceScores,
                uploadedPhotoHashes,
                profileMedia,
                acceptedPhotoCount: photos.length,
              },
            });
            return droppedRefs.size;
          });
        },
        persistOutcome: async (input) => {
          return await prisma.$transaction(async (tx): Promise<PersistOutcomeResult> => {
            // Same lock as every photo upload and delete, then a fresh read of
            // the photos (audit A13-H12). The verdict — and above all the
            // activation — is only valid for the set that was scored; checking
            // it outside the lock would still let an upload commit between the
            // check and the write and ride an activation it never earned.
            await lockUserRow(tx, input.userId);
            const row = await tx.user.findUnique({
              where: { id: input.userId },
              select: {
                status: true,
                onboardingStep: true,
                registrationTrack: true,
                email: true,
                isEmailVerified: true,
                phoneVerifiedAt: true,
                profile: { select: { photos: true } },
              },
            });
            if (!row) return { kind: "persisted" };
            if (!samePhotoSet(row.profile?.photos ?? [], input.photosSnapshot)) {
              return { kind: "photos_changed" };
            }

            const now = new Date();
            // Status flips only `onboarding` → `active`, so admin-moderated
            // states (paused, suspended, banned) survive a verified outcome, and
            // only for an account that finished onboarding with a verified track
            // contact (audit A13-M18) — re-checked here under the lock rather
            // than trusted from the pipeline's earlier read.
            const activate =
              input.shouldActivate &&
              row.status === "onboarding" &&
              activationBlockerFor(row) === null;
            await tx.user.update({
              where: { id: input.userId },
              data: {
                verificationStatus: input.verificationStatus,
                ...(input.shouldActivate ? { verifiedAt: now } : {}),
                ...(activate ? { status: "active" as const } : {}),
                faceMatchScore: input.faceMatchScore,
                faceMatchedAt: now,
                // Never null out a stored reference: a failed upload this run
                // must not turn the user's next photo edit into
                // `reference_expired` (audit A13-H11).
                ...(input.verifiedSelfiePath
                  ? { verifiedSelfiePath: input.verifiedSelfiePath }
                  : {}),
                personaInquiryId: input.sessionId,
              },
            });

            // The score array is keyed 1:1 to the photos array, which the check
            // above just proved is the one that was scored.
            if (input.photoFaceScores.length > 0) {
              await tx.profile.update({
                where: { userId: input.userId },
                data: { photoFaceScores: input.photoFaceScores },
              });
            }
            return { kind: "persisted" };
          });
        },
      },
      // Last, so a caller-supplied dep wins over the default built above.
      // Empty in production — only demo mode passes anything here.
      ...(options.depsOverride ?? {}),
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
 *     reference selfie to compare against. A first check that is still
 *     scoring has none yet either — which is safe only because that run's own
 *     locked persist sees the edit and re-scores, parking its session and
 *     selfie on the row first so edits after that point rerun normally
 *     (audit A13-H12).
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
