import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.mock("../config.js", () => ({
  env: { PHONE_AUTH_ENABLED: true, AI_MEMORY_EXPORT_ENABLED: false },
}));

import { MIN_PHOTOS } from "@gennety/shared";
import {
  resolveOnboardingStage,
  type OnboardingStageFlags,
  type OnboardingStageState,
} from "./onboarding-stage.js";

const FLAGS: OnboardingStageFlags = {
  phoneAuthEnabled: true,
  aiMemoryExportEnabled: false,
};

/** A brand-new row: `/start` created it and nothing has been answered. */
function fresh(over: Partial<OnboardingStageState> = {}): OnboardingStageState {
  return {
    onboardingStep: "consent",
    language: null,
    termsAccepted: false,
    registrationTrack: null,
    email: null,
    isEmailVerified: false,
    phoneVerifiedAt: null,
    themeChosenAt: null,
    firstName: null,
    age: null,
    gender: null,
    preference: null,
    aiMemoryExportPreference: "undecided",
    profile: null,
    onboardingProgress: null,
    ...over,
  };
}

/** Every Mini App screen answered, general track. */
function miniAppDone(over: Partial<OnboardingStageState> = {}): OnboardingStageState {
  return fresh({
    onboardingStep: "language",
    language: "ru",
    termsAccepted: true,
    registrationTrack: "general",
    phoneVerifiedAt: new Date("2026-08-01T10:00:00Z"),
    themeChosenAt: new Date("2026-08-01T10:01:00Z"),
    firstName: "Максим",
    age: 24,
    gender: "male",
    preference: "women",
    aiMemoryExportPreference: "declined",
    profile: { homeCityKey: "ua:kyiv", height: 180 },
    ...over,
  });
}

const stage = (u: OnboardingStageState) => resolveOnboardingStage(u, FLAGS).id;

describe("resolveOnboardingStage — the bug this module exists for", () => {
  it("does NOT report 'language' for the production row that got five wrong nudges", () => {
    // Real production state (audited 2026-08-12): onboardingStep='language',
    // language picked, terms accepted, nothing else. It received all five
    // touches telling it to choose a language.
    const victim = fresh({
      onboardingStep: "language",
      language: "uk",
      termsAccepted: true,
    });

    const resolved = resolveOnboardingStage(victim, FLAGS);
    expect(resolved.id).not.toBe("language");
    expect(resolved.id).toBe("signup_track");
    expect(resolved.description).not.toMatch(/language picker/i);
  });

  it("never reports 'language' once a language is set, at any later stage", () => {
    const later: OnboardingStageState[] = [
      fresh({ onboardingStep: "language", language: "ru", termsAccepted: true }),
      miniAppDone({ profile: { homeCityKey: null, height: null } }),
      miniAppDone({ themeChosenAt: null }),
      miniAppDone({ firstName: null }),
      miniAppDone(),
      miniAppDone({ onboardingStep: "conversational" }),
    ];
    for (const user of later) {
      expect(stage(user)).not.toBe("language");
    }
  });

  it("distinguishes stages the onboardingStep column cannot tell apart", () => {
    // All six carry onboardingStep='language' — the column's blind spot.
    const ids = [
      fresh({ onboardingStep: "language", language: "ru", termsAccepted: true }),
      miniAppDone({ phoneVerifiedAt: null, profile: { homeCityKey: null, height: null } }),
      miniAppDone({ profile: { homeCityKey: null, height: null } }),
      miniAppDone({ themeChosenAt: null }),
      miniAppDone({ gender: null }),
      miniAppDone(),
    ].map(stage);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveOnboardingStage — Mini App order", () => {
  it("asks for the language first", () => {
    expect(stage(fresh())).toBe("language");
  });

  it("asks for consent once the language is picked", () => {
    expect(stage(fresh({ language: "ru" }))).toBe("consent");
  });

  it("routes an unresolved contact before the city", () => {
    const noTrack = fresh({ language: "ru", termsAccepted: true });
    expect(stage(noTrack)).toBe("signup_track");
    expect(stage({ ...noTrack, registrationTrack: "general" })).toBe("phone_share");
    expect(stage({ ...noTrack, registrationTrack: "student" })).toBe("email_otp");
  });

  it("falls back to the email rail when the phone rail is off", () => {
    const noTrack = fresh({ language: "ru", termsAccepted: true });
    const emailOnly = { phoneAuthEnabled: false, aiMemoryExportEnabled: false };
    expect(resolveOnboardingStage(noTrack, emailOnly).id).toBe("email_otp");
    // A general-track row predating the flag flip must not be sent to a phone
    // screen the client will not render.
    expect(
      resolveOnboardingStage({ ...noTrack, registrationTrack: "general" }, emailOnly).id,
    ).toBe("email_otp");
  });

  it("names the entered email only when there is one to name", () => {
    const student = fresh({
      language: "ru",
      termsAccepted: true,
      registrationTrack: "student",
    });
    expect(resolveOnboardingStage(student, FLAGS).description).toMatch(/no university email/i);
    expect(
      resolveOnboardingStage({ ...student, email: "a@uni.edu" }, FLAGS).description,
    ).toMatch(/never entered the code/i);
  });

  it("accepts either verified rail as satisfying the contact gate", () => {
    const emailVerified = fresh({
      language: "ru",
      termsAccepted: true,
      registrationTrack: "student",
      email: "a@uni.edu",
      isEmailVerified: true,
    });
    expect(stage(emailVerified)).toBe("city");
  });

  it("walks city → theme → basics → handoff", () => {
    expect(stage(miniAppDone({ profile: { homeCityKey: null, height: null } }))).toBe("city");
    expect(stage(miniAppDone({ themeChosenAt: null }))).toBe("theme");
    expect(stage(miniAppDone({ preference: null }))).toBe("profile_basics");
    expect(stage(miniAppDone())).toBe("handoff");
  });

  it("names the first unanswered profile screen, not just 'the profile screens'", () => {
    const describe_ = (over: Partial<OnboardingStageState>) =>
      resolveOnboardingStage(miniAppDone(over), FLAGS).description;

    expect(describe_({ firstName: null })).toMatch(/their name/);
    expect(describe_({ age: null })).toMatch(/their age/);
    expect(describe_({ gender: null })).toMatch(/their gender/);
    expect(describe_({ preference: null })).toMatch(/who they want to meet/);
    expect(describe_({ profile: { homeCityKey: "ua:kyiv", height: null } })).toMatch(
      /their height/,
    );
  });

  it("only offers the AI-memory step while the kill switch is on", () => {
    const undecided = miniAppDone({ aiMemoryExportPreference: "undecided" });
    expect(stage(undecided)).toBe("handoff");
    expect(
      resolveOnboardingStage(undecided, { ...FLAGS, aiMemoryExportEnabled: true }).id,
    ).toBe("ai_memory_choice");
  });
});

describe("resolveOnboardingStage — conversational phase", () => {
  const chat = (currentQuestion: string | null) =>
    resolveOnboardingStage(
      miniAppDone({ onboardingStep: "conversational", onboardingProgress: { currentQuestion } }),
      FLAGS,
    );

  it("keys off the collector's own next question", () => {
    expect(chat("hobbies").id).toBe("chat_hobbies");
    expect(chat("partner_preferences").id).toBe("chat_partner_preferences");
    expect(chat("friday_vibe").id).toBe("chat_vibe");
    expect(chat("vibe_focus").id).toBe("chat_vibe");
    expect(chat("ai_memory").id).toBe("chat_ai_memory");
    expect(chat("context_dump").id).toBe("chat_context_dump");
    expect(chat("photos").id).toBe("chat_photos");
    expect(chat("complete").id).toBe("chat_finalize");
  });

  it("names the photo minimum rather than leaving it vague", () => {
    expect(chat("photos").description).toContain(`at least ${MIN_PHOTOS}`);
  });

  it("degrades to a generic chat line for a legacy row with no progress", () => {
    expect(chat(null).id).toBe("chat_basics");
    expect(chat("something_new").id).toBe("chat_basics");
  });

  it("stops reading Mini App state once the chat owns the flow", () => {
    // A conversational user whose Mini App fields are incomplete (older bundle
    // or the iOS rail) is described by the chat question, not by the screen
    // they never saw.
    const handedOff = miniAppDone({
      onboardingStep: "conversational",
      firstName: null,
      onboardingProgress: { currentQuestion: "first_name_age" },
    });
    expect(resolveOnboardingStage(handedOff, FLAGS).id).toBe("chat_basics");
  });
});

describe("resolveOnboardingStage — registration flag", () => {
  it("is true for every stage before the profile screens", () => {
    const registering = [
      fresh(),
      fresh({ language: "ru" }),
      fresh({ language: "ru", termsAccepted: true }),
      fresh({ language: "ru", termsAccepted: true, registrationTrack: "general" }),
      fresh({ language: "ru", termsAccepted: true, registrationTrack: "student" }),
      miniAppDone({ profile: { homeCityKey: null, height: null } }),
      miniAppDone({ themeChosenAt: null }),
    ];
    for (const user of registering) {
      expect(resolveOnboardingStage(user, FLAGS).registration).toBe(true);
    }
  });

  it("is false once the profile is the unfinished thing", () => {
    const withProfile = [
      miniAppDone({ firstName: null }),
      miniAppDone(),
      miniAppDone({
        onboardingStep: "conversational",
        onboardingProgress: { currentQuestion: "photos" },
      }),
    ];
    for (const user of withProfile) {
      expect(resolveOnboardingStage(user, FLAGS).registration).toBe(false);
    }
  });
});
