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
    // Default fixtures treat the theme as already picked so pre-existing
    // post-city routing tests are unaffected; theme-gate routing is covered
    // by its own cases below.
    theme: "dark",
    themeChosen: true,
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
    // Referral welcome gift defaults: not a referred user, so the gift screen
    // is skipped and existing post-visual routing tests are unaffected.
    invitedByReferral: false,
    referralGiftSeen: false,
    referrerFirstName: null,
    referralGiftMonths: 1,
    // Promo welcome gift defaults: not a promo user, so the promo screen is
    // skipped and existing routing tests are unaffected.
    invitedByPromo: false,
    promoGiftSeen: false,
    promoCode: null,
    promoTickets: 1,
    promoMonths: 3,
    // Launched markets: Kyiv only (packages/shared/src/markets.ts).
    supportedCities: [
      {
        label: "Kyiv, UA",
        homeCity: "Kyiv",
        homeCountryCode: "UA",
        homeCityKey: "ua:kyiv",
        homePlaceId: null,
        latitude: 50.4501,
        longitude: 30.5234,
      },
    ],
    // Profile-screen defaults: already answered, so the five Mini App screens
    // are skipped and pre-existing post-visual routing tests are unaffected.
    profileBasics: {
      firstName: "Alice",
      age: 24,
      gender: "female",
      preference: "men",
      height: 170,
    },
    profileLimits: { minAge: 18, maxAge: 55, minHeightCm: 140, maxHeightCm: 220 },
    homeLocation: null,
    completed: false,
    ...overrides,
  };
}

const NO_BASICS = {
  firstName: null,
  age: null,
  gender: null,
  preference: null,
  height: null,
} as const;

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

describe("theme picker routing (after the city gate)", () => {
  it("shows the theme picker after the city gate when not yet chosen (pre-visual)", () => {
    expect(preVisualPhaseFromRemote(visualReadyUser({ themeChosen: false }))).toEqual({
      kind: "theme",
    });
  });

  it("proceeds to the visual intro once the theme is chosen", () => {
    expect(preVisualPhaseFromRemote(visualReadyUser({ themeChosen: true }))).toEqual({
      kind: "visual",
      index: 0,
    });
  });

  it("still gates on the theme picker post-visual before AI-memory", () => {
    expect(postVisualPhaseFromRemote(visualReadyUser({ themeChosen: false }))).toEqual({
      kind: "theme",
    });
  });

  it("shows the referral gift screen (before AI-memory) for an invited user", () => {
    expect(
      postVisualPhaseFromRemote(
        visualReadyUser({ invitedByReferral: true, referralGiftSeen: false }),
      ),
    ).toEqual({ kind: "referralGift" });
  });

  it("skips the referral gift once it has been seen/claimed", () => {
    expect(
      postVisualPhaseFromRemote(
        visualReadyUser({ invitedByReferral: true, referralGiftSeen: true }),
      ),
    ).toEqual({ kind: "aiMemoryExport" });
  });

  it("shows the promo gift screen (before AI-memory) for a promo user", () => {
    expect(
      postVisualPhaseFromRemote(visualReadyUser({ invitedByPromo: true, promoGiftSeen: false })),
    ).toEqual({ kind: "promoGift" });
  });

  it("skips the promo gift once it has been seen/claimed", () => {
    expect(
      postVisualPhaseFromRemote(visualReadyUser({ invitedByPromo: true, promoGiftSeen: true })),
    ).toEqual({ kind: "aiMemoryExport" });
  });

  it("prefers the promo gift over the referral gift when both are set", () => {
    expect(
      postVisualPhaseFromRemote(
        visualReadyUser({ invitedByPromo: true, invitedByReferral: true }),
      ),
    ).toEqual({ kind: "promoGift" });
  });

  it("ignores stored visual progress until a theme is chosen", () => {
    expect(bootPhaseFromRemote(visualReadyUser({ themeChosen: false }), 2)).toEqual({
      kind: "theme",
    });
  });
});

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

  it("skips the AI-memory screen entirely when the server disables the feature", () => {
    // `AI_MEMORY_EXPORT_ENABLED=false`: undecided must NOT strand the user on a
    // choice screen the server no longer accepts (`POST /ai-memory` 404s).
    expect(
      bootPhaseFromRemote(
        visualReadyUser({
          aiMemoryExportPreference: "undecided",
          aiMemoryExportEnabled: false,
        }),
        VISUAL_DONE,
      ),
    ).toEqual({ kind: "loading" });
  });

  it("still shows the AI-memory screen when the server reports it enabled", () => {
    expect(
      bootPhaseFromRemote(
        visualReadyUser({
          aiMemoryExportPreference: "undecided",
          aiMemoryExportEnabled: true,
        }),
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

/**
 * Phone-based account login (PRODUCT_SPEC §1.1): sharing a contact that belongs
 * to an existing account swaps the server-side user underneath a live Mini App
 * session, so `/state` can start returning a fully onboarded user mid-flow.
 */
describe("an already-onboarded user has nothing left in the Mini App", () => {
  it("routes straight to done instead of replaying the gates", () => {
    expect(
      preVisualPhaseFromRemote(
        user({
          onboardingStep: "completed",
          // Deliberately unset: a completed account must not be pulled back
          // into the city/theme gates by missing pre-visual fields.
          homeLocation: null,
          themeChosen: false,
        }),
      ),
    ).toEqual({ kind: "done" });
  });

  it("routes to done from the post-visual phase too", () => {
    expect(postVisualPhaseFromRemote(user({ onboardingStep: "completed" }))).toEqual({
      kind: "done",
    });
  });

  it("ignores stored visual progress for a completed account", () => {
    expect(bootPhaseFromRemote(user({ onboardingStep: "completed" }), 3)).toEqual({
      kind: "done",
    });
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

describe("Telegram onboarding profile screens", () => {
  const ready = {
    homeLocation: {
      homeCity: "Kyiv",
      homeCountryCode: "UA",
      homeCityKey: "ua:kyiv",
      homePlaceId: null,
      latitude: 50.4501,
      longitude: 30.5234,
      locationUpdatedAt: null,
    },
    isEmailVerified: true,
    aiMemoryExportPreference: "declined" as const,
  };

  it("asks the first unanswered profile question after the intro", () => {
    expect(
      postVisualPhaseFromRemote(user({ ...ready, profileBasics: { ...NO_BASICS } })),
    ).toEqual({ kind: "basics", step: "name" });
  });

  it("resumes on the screen the user stopped at", () => {
    expect(
      postVisualPhaseFromRemote(
        user({
          ...ready,
          profileBasics: { ...NO_BASICS, firstName: "Alice", age: 24 },
        }),
      ),
    ).toEqual({ kind: "basics", step: "gender" });

    expect(
      postVisualPhaseFromRemote(
        user({
          ...ready,
          profileBasics: {
            firstName: "Alice",
            age: 24,
            gender: "female",
            preference: "men",
            height: null,
          },
        }),
      ),
    ).toEqual({ kind: "basics", step: "height" });
  });

  it("skips the screens once every field is answered", () => {
    expect(postVisualPhaseFromRemote(user(ready))).toEqual({ kind: "loading" });
  });

  it("sits after the welcome gift and before the AI-memory choice", () => {
    const invited = user({
      ...ready,
      aiMemoryExportPreference: "undecided",
      aiMemoryExportEnabled: true,
      invitedByReferral: true,
      referralGiftSeen: false,
      profileBasics: { ...NO_BASICS },
    });
    // Gift first…
    expect(postVisualPhaseFromRemote(invited)).toEqual({ kind: "referralGift" });
    // …then the profile screens…
    expect(
      postVisualPhaseFromRemote({ ...invited, referralGiftSeen: true }),
    ).toEqual({ kind: "basics", step: "name" });
    // …and the AI-memory choice is still the last thing the Mini App asks.
    expect(
      postVisualPhaseFromRemote(
        user({
          ...ready,
          aiMemoryExportPreference: "undecided",
          aiMemoryExportEnabled: true,
          invitedByReferral: true,
          referralGiftSeen: true,
        }),
      ),
    ).toEqual({ kind: "aiMemoryExport" });
  });

  it("routes past the screens against a server that predates them", () => {
    const legacy = user(ready);
    delete (legacy as { profileBasics?: unknown }).profileBasics;
    expect(postVisualPhaseFromRemote(legacy)).toEqual({ kind: "loading" });
  });

  it("never shows a profile screen before the city gate", () => {
    expect(
      preVisualPhaseFromRemote(
        user({ ...ready, homeLocation: null, profileBasics: { ...NO_BASICS } }),
      ),
    ).toEqual({ kind: "city" });
  });
});
