import { describe, expect, it } from "vitest";
import type { TelegramOnboardingState } from "./api.js";
import { preVisualPhaseFromRemote } from "./onboarding-route.js";

function user(
  overrides: Partial<TelegramOnboardingState["user"]> = {},
): TelegramOnboardingState["user"] {
  return {
    onboardingStep: "language",
    aiMemoryExportPreference: "undecided",
    aiMemoryExportPreferenceAt: null,
    termsAccepted: true,
    researchOptIn: false,
    language: "en",
    email: "alice@stanford.edu",
    isEmailVerified: false,
    emailVerification: {
      status: "none",
      expiresAt: null,
      resendAvailableAt: null,
      attemptsRemaining: 5,
    },
    homeLocation: null,
    completed: false,
    ...overrides,
  };
}

describe("Telegram onboarding route restoration", () => {
  it("restores the OTP screen for a pending challenge", () => {
    expect(
      preVisualPhaseFromRemote(
        user({
          emailVerification: {
            status: "pending",
            expiresAt: "2026-06-07T10:10:00.000Z",
            resendAvailableAt: "2026-06-07T10:00:30.000Z",
            attemptsRemaining: 5,
          },
        }),
      ),
    ).toEqual({
      kind: "otp",
      email: "alice@stanford.edu",
      expiresAt: "2026-06-07T10:10:00.000Z",
      resendAvailableAt: "2026-06-07T10:00:30.000Z",
    });
  });

  it.each(["none", "expired", "exhausted"] as const)(
    "returns to email entry for a %s challenge",
    (status) => {
      expect(
        preVisualPhaseFromRemote(
          user({
            emailVerification: {
              status,
              expiresAt: null,
              resendAvailableAt: null,
              attemptsRemaining: 0,
            },
          }),
        ),
      ).toEqual({ kind: "email" });
    },
  );
});
