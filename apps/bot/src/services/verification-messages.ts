import { t, type Language } from "@gennety/shared";
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
