import { t, type Language } from "@gennety/shared";
import type { LivenessRetryOutcome } from "./face-liveness.js";
import type { TerminalVerificationStatus } from "./verification-pipeline.js";

export function terminalVerificationMessage(
  language: Language,
  status: TerminalVerificationStatus,
): string {
  switch (status) {
    case "verified":
      return t(language, "verifyOutcomeVerified");
    case "pending_review":
      return t(language, "verifyOutcomePendingReview");
    case "rejected":
      return t(language, "verifyOutcomeRejected");
  }
}

/**
 * Copy for a run that could not reach a verdict because the reference selfie
 * was unavailable (PRODUCT_SPEC §1.4 — retryable, never `pending_review`).
 *
 * Reuses the ordinary reminder rather than inventing a fifth outcome string:
 * nothing about the user's own state changed, and the action is identical —
 * start the check. Also keeps the five-language copy in one place.
 */
export function verificationRetryMessage(language: Language): string {
  return t(language, "verifyReminderNudge");
}

/**
 * Copy for the retry nudge sent immediately after AWS's OWN liveness detector
 * reports a non-pass (`completeLivenessCheck` in `liveness-flow.ts`). Profile
 * photos are never looked at on this path — `CompareFaces` only runs after a
 * `passed` liveness result — so every one of these three variants leads with
 * the same reassurance: your photos are not the problem, this check never got
 * that far.
 *
 * The three outcomes are genuinely different situations and get different
 * advice instead of a single "shaky camera or low light" guess:
 *   - `not_live` ran to completion but didn't clear the confidence bar —
 *     lighting/framing/obstruction advice actually applies here.
 *   - `expired` / `in_progress` never finished at all (window closed, or the
 *     client reported done before AWS settled) — the fix is "go through it
 *     without switching away", not a camera tip.
 *   - `no_reference` is OUR infrastructure dropping the frame after a genuine
 *     pass — no advice is owed, only an apology and "try again".
 */
export function livenessRetryMessage(
  language: Language,
  outcome: LivenessRetryOutcome,
): string {
  switch (outcome) {
    case "not_live":
      return t(language, "verifyRetryNotLive");
    case "expired":
    case "in_progress":
      return t(language, "verifyRetryUnfinished");
    case "no_reference":
      return t(language, "verifyRetryTechnical");
  }
}

/**
 * Lock-screen copy for the native rail. A push is a title plus a body, not the
 * DM string reused: the DM leans on an inline keyboard right below it ("tap 📷
 * below to swap them") that has no counterpart on a lock screen, and it is long
 * enough that iOS would truncate the sentence carrying the actual verdict.
 *
 * Meaning is kept in lockstep with `terminalVerificationMessage` on purpose —
 * a `both` user gets both rails for the same event, and two rails disagreeing
 * about what happened is worse than either alone. Rejection therefore leads
 * with "these aren't your photos" here too (the DM's `photoRedoFirst` ordering,
 * `verification-pipeline.ts`), and a pass stays a single short confirmation.
 */
export interface PushCopy {
  title: string;
  body: string;
}

export function terminalVerificationPush(
  language: Language,
  status: TerminalVerificationStatus,
): PushCopy {
  switch (status) {
    case "verified":
      return {
        title: t(language, "verifyPushVerifiedTitle"),
        body: t(language, "verifyPushVerifiedBody"),
      };
    case "pending_review":
      return {
        title: t(language, "verifyPushPendingReviewTitle"),
        body: t(language, "verifyPushPendingReviewBody"),
      };
    case "rejected":
      return {
        title: t(language, "verifyPushRejectedTitle"),
        body: t(language, "verifyPushRejectedBody"),
      };
  }
}

/** Push twin of `verificationRetryMessage` — same "start the check" ask. */
export function verificationRetryPush(language: Language): PushCopy {
  return {
    title: t(language, "verifyPushRetryTitle"),
    body: t(language, "verifyPushRetryBody"),
  };
}

/**
 * Push twin of `verifyPhotosBelowMinimum`: verified, but held out of the pool
 * until the profile is refilled. Both numbers travel with it — the title names
 * what to do and the body says why, so a user who only reads the banner still
 * knows the count.
 */
export function verificationPhotosNeededPush(
  language: Language,
  counts: { min: number; need: number },
): PushCopy {
  return {
    title: t(language, "verifyPushPhotosNeededTitle", counts),
    body: t(language, "verifyPushPhotosNeededBody", counts),
  };
}

/** Push twin of `verifyPhotosDropped` — photos vanished, and here is why. */
export function verificationPhotosDroppedPush(language: Language): PushCopy {
  return {
    title: t(language, "verifyPushPhotosDroppedTitle"),
    body: t(language, "verifyPushPhotosDroppedBody"),
  };
}
