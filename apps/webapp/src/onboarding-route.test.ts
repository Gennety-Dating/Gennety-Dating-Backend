import { describe, expect, it } from "vitest";
import type { TelegramOnboardingState } from "./api.js";
import {
  bootPhaseFromRemote,
  DATEFLOW_LAST_INDEX,
  postVisualPhaseFromRemote,
  preVisualPhaseFromRemote,
  VISUAL_DONE,
  VISUAL_LAST_INDEX,
} from "./onboarding-route.js";

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
    // Registration v2 defaults: phone rail off → the legacy email-only flow.
    isPhoneVerified: false,
    phone: null,
    registrationTrack: null,
    phoneAuthEnabled: false,
    homeLocation: null,
    completed: false,
    ...overrides,
  };
}

describe("Telegram onboarding route restoration", () => {
  it("shows language before consent for a new user", () => {
    expect(
      preVisualPhaseFromRemote(
        user({
          language: null,
          termsAccepted: false,
        }),
      ),
    ).toEqual({ kind: "language" });
  });

  it("shows translated consent after language is selected", () => {
    expect(
      preVisualPhaseFromRemote(
        user({
          language: "de",
          termsAccepted: false,
        }),
      ),
    ).toEqual({ kind: "consent" });
  });

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

// A user who has cleared every server gate up to (and including) the city,
// so the next phase is the client-only visual animation.
function visualReadyUser(
  overrides: Partial<TelegramOnboardingState["user"]> = {},
): TelegramOnboardingState["user"] {
  return user({
    isEmailVerified: true,
    homeLocation: {
      homeCity: "Kyiv",
      homeCountryCode: "UA",
      homeCityKey: "kyiv-ua",
      homePlaceId: null,
      latitude: 50.45,
      longitude: 30.52,
      locationUpdatedAt: null,
    },
    ...overrides,
  });
}

describe("bootPhaseFromRemote — visual animation resume", () => {
  it("starts at scene 0 when there is no stored progress", () => {
    expect(bootPhaseFromRemote(visualReadyUser(), null)).toEqual({
      kind: "visual",
      index: 0,
    });
  });

  it("resumes at the stored scene index", () => {
    expect(bootPhaseFromRemote(visualReadyUser(), 2)).toEqual({
      kind: "visual",
      index: 2,
    });
  });

  it("clamps an out-of-range stored index to the last scene", () => {
    expect(bootPhaseFromRemote(visualReadyUser(), VISUAL_LAST_INDEX + 0.4)).toEqual({
      kind: "visual",
      index: VISUAL_LAST_INDEX,
    });
    expect(bootPhaseFromRemote(visualReadyUser(), -3)).toEqual({
      kind: "visual",
      index: 0,
    });
  });

  it("jumps to the AI-memory phase once the animation was completed (undecided)", () => {
    expect(
      bootPhaseFromRemote(
        visualReadyUser({ aiMemoryExportPreference: "undecided" }),
        VISUAL_DONE,
      ),
    ).toEqual({ kind: "aiMemoryExport" });
  });

  it("jumps to the loading phase once the animation was completed (decided)", () => {
    expect(
      bootPhaseFromRemote(
        visualReadyUser({ aiMemoryExportPreference: "accepted" }),
        VISUAL_DONE,
      ),
    ).toEqual({ kind: "loading" });
  });

  it("ignores stored progress when the server says the user is pre-animation", () => {
    // Still on the email gate — a stale value must not skip ahead.
    expect(
      bootPhaseFromRemote(user({ isEmailVerified: false, homeLocation: null }), VISUAL_DONE),
    ).toEqual({ kind: "email" });
  });
});

describe("Registration v2 sign-up fork (phoneAuthEnabled)", () => {
  it("keeps the legacy email flow when the phone rail is off", () => {
    expect(preVisualPhaseFromRemote(user({ phoneAuthEnabled: false }))).toEqual({
      kind: "email",
    });
  });

  it("shows the path chooser when the rail is on and no track is chosen", () => {
    expect(preVisualPhaseFromRemote(user({ phoneAuthEnabled: true }))).toEqual({
      kind: "path",
    });
  });

  it("routes the student track to the email gate", () => {
    expect(
      preVisualPhaseFromRemote(user({ phoneAuthEnabled: true, registrationTrack: "student" })),
    ).toEqual({ kind: "email" });
  });

  it("routes the general track to the phone gate", () => {
    expect(
      preVisualPhaseFromRemote(user({ phoneAuthEnabled: true, registrationTrack: "general" })),
    ).toEqual({ kind: "phone" });
  });

  it("skips the fork entirely for an email-verified handoff user", () => {
    expect(
      preVisualPhaseFromRemote(user({ phoneAuthEnabled: true, isEmailVerified: true })),
    ).toEqual({ kind: "city" });
  });

  it("passes the contact stage once the phone is verified", () => {
    expect(
      preVisualPhaseFromRemote(
        user({ phoneAuthEnabled: true, registrationTrack: "general", isPhoneVerified: true }),
      ),
    ).toEqual({ kind: "city" });
  });
});

describe("optional 'Подробнее' date-flow walkthrough", () => {
  it("exposes the final date-flow screen index", () => {
    expect(DATEFLOW_LAST_INDEX).toBe(5);
  });

  it("does not change post-visual routing (detail is entered only via the button)", () => {
    expect(postVisualPhaseFromRemote(visualReadyUser())).toEqual({
      kind: "aiMemoryExport",
    });
  });
});
