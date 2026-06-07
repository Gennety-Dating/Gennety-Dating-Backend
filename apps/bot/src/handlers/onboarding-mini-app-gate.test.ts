import { describe, expect, it } from "vitest";
import { shouldUseOnboardingMiniApp } from "./onboarding-mini-app-gate.js";

const readyUser = {
  onboardingStep: "conversational" as const,
  termsAccepted: true,
  language: "ru" as const,
  isEmailVerified: true,
  aiMemoryExportPreference: "accepted" as const,
};

describe("shouldUseOnboardingMiniApp", () => {
  it("opens for a fresh onboarding user", () => {
    expect(
      shouldUseOnboardingMiniApp(
        true,
        {
          ...readyUser,
          onboardingStep: "consent",
          termsAccepted: false,
          language: null,
          isEmailVerified: false,
          aiMemoryExportPreference: "undecided",
        },
        false,
      ),
    ).toBe(true);
  });

  it("reopens for conversational users missing Mini App gates", () => {
    expect(shouldUseOnboardingMiniApp(true, readyUser, false)).toBe(true);
    expect(
      shouldUseOnboardingMiniApp(
        true,
        { ...readyUser, aiMemoryExportPreference: "undecided" },
        true,
      ),
    ).toBe(true);
  });

  it("stays in chat after the complete Mini App handoff", () => {
    expect(shouldUseOnboardingMiniApp(true, readyUser, true)).toBe(false);
  });

  it("never opens for completed users or without a configured webapp", () => {
    expect(
      shouldUseOnboardingMiniApp(
        true,
        { ...readyUser, onboardingStep: "completed" },
        true,
      ),
    ).toBe(false);
    expect(shouldUseOnboardingMiniApp(false, readyUser, true)).toBe(false);
  });
});
