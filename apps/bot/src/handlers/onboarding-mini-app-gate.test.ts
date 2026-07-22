import { describe, expect, it } from "vitest";
import { shouldUseOnboardingMiniApp } from "./onboarding-mini-app-gate.js";

const readyUser = {
  onboardingStep: "conversational" as const,
  termsAccepted: true,
  language: "ru" as const,
  isEmailVerified: true,
  registrationTrack: null,
  email: "a@uni.edu",
  phoneVerifiedAt: null,
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
          email: null,
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

  // Registration v2 general track: the contact rail is a verified phone, never
  // an email. A track-blind gate keyed on isEmailVerified would treat this user
  // as "never ready" and bounce /start back into the Mini App forever.
  it("stays in chat for a general-track user verified by phone", () => {
    expect(
      shouldUseOnboardingMiniApp(
        true,
        {
          ...readyUser,
          registrationTrack: "general",
          isEmailVerified: false,
          email: null,
          phoneVerifiedAt: new Date(),
        },
        true,
      ),
    ).toBe(false);
  });

  it("reopens for a general-track user who has not verified a phone yet", () => {
    expect(
      shouldUseOnboardingMiniApp(
        true,
        {
          ...readyUser,
          registrationTrack: "general",
          isEmailVerified: false,
          email: null,
          phoneVerifiedAt: null,
        },
        true,
      ),
    ).toBe(true);
  });

  it("does not let a general-track user's stray email satisfy the gate", () => {
    // A general-track user whose email happens to be set (e.g. switched tracks)
    // but is unverified-for-their-track must still not hand off on email alone.
    expect(
      shouldUseOnboardingMiniApp(
        true,
        {
          ...readyUser,
          registrationTrack: "general",
          isEmailVerified: true,
          email: "a@uni.edu",
          phoneVerifiedAt: null,
        },
        true,
      ),
    ).toBe(true);
  });
});
