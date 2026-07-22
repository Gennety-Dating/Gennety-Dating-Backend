import type { AiMemoryExportPreference, Language, OnboardingStep } from "@gennety/db";
import { hasTrackVerifiedContact } from "../services/contact-verification.js";

interface OnboardingMiniAppGateUser {
  onboardingStep: OnboardingStep;
  termsAccepted: boolean;
  language: Language | null;
  // Registration v2 contact rail — the handoff is track-aware: the student /
  // legacy track proves a university email, the general track a verified phone.
  // Keying readiness on email alone would strand every general-track user
  // (isEmailVerified never becomes true for them) and bounce /start back into
  // the Mini App on every re-entry.
  registrationTrack: string | null;
  email: string | null;
  isEmailVerified: boolean;
  phoneVerifiedAt: Date | null;
  aiMemoryExportPreference: AiMemoryExportPreference;
}

export function shouldUseOnboardingMiniApp(
  webAppConfigured: boolean,
  user: OnboardingMiniAppGateUser,
  hasHomeLocation: boolean,
): boolean {
  if (!webAppConfigured || user.onboardingStep === "completed") return false;

  const miniAppHandoffReady =
    user.termsAccepted &&
    user.language !== null &&
    hasTrackVerifiedContact(user) &&
    hasHomeLocation &&
    user.aiMemoryExportPreference !== "undecided";

  return !miniAppHandoffReady;
}
