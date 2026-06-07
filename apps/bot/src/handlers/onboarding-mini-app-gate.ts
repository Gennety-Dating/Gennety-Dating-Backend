import type { AiMemoryExportPreference, Language, OnboardingStep } from "@gennety/db";

interface OnboardingMiniAppGateUser {
  onboardingStep: OnboardingStep;
  termsAccepted: boolean;
  language: Language | null;
  isEmailVerified: boolean;
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
    user.isEmailVerified &&
    hasHomeLocation &&
    user.aiMemoryExportPreference !== "undecided";

  return !miniAppHandoffReady;
}
