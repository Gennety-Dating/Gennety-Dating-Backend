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
