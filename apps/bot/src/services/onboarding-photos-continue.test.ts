import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Continue" on the photo stage must not be a back door around the collector.
 *
 * This lives in its own file because it needs `./onboarding-collector.js`
 * mocked, and `onboarding-agent.test.ts` exercises the REAL collector helpers
 * throughout (`markOnboardingField`, the question/validation copy). A file-wide
 * mock there would silently change what those suites are testing.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  collect: vi.fn(),
  questionText: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate },
    profile: { upsert: vi.fn() },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    ONBOARDING_FACT_COLLECTOR_ENABLED: true,
    AI_MEMORY_EXPORT_ENABLED: false,
    OPENAI_API_KEY: "test-key",
    WEBAPP_URL: "https://test.invalid/app",
    TYPE_RADAR_ENABLED: false,
  },
}));

vi.mock("./onboarding-collector.js", () => ({
  collectOnboardingInput: mocks.collect,
  markOnboardingField: vi.fn(),
  onboardingQuestionText: mocks.questionText,
  onboardingValidationText: vi.fn(() => null),
  onboardingNotUnderstoodText: vi.fn(() => null),
}));

vi.mock("./type-radar.js", () => ({
  typeRadarGatePending: vi.fn(() => false),
  typeRadarInviteCopy: vi.fn(() => ({ intro: "radar" })),
}));

import { runAgentTurn } from "./onboarding-agent.js";

const TELEGRAM_ID = 782065541n;

/** The agent's own read: a collector-owned account with a verified rail. */
function collectorOwnedUser() {
  return {
    id: "uuid-1",
    messageHistory: [],
    onboardingStep: "conversational",
    language: "uk",
    registrationTrack: "general",
    phoneVerifiedAt: new Date(),
    isEmailVerified: false,
    termsAccepted: true,
    aiMemoryExportPreference: "undecided",
    firstName: "Гліб",
    age: 24,
    gender: "male",
    preference: "women",
    onboardingProgress: { completedFields: [] },
    profile: {
      height: 182,
      hobbies: [],
      partnerPreferences: null,
      photos: ["a", "b", "c"],
      homeCityKey: "ua:kyiv",
      typeRadarCompletedAt: new Date(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue(collectorOwnedUser());
  mocks.userUpdate.mockResolvedValue({});
  mocks.questionText.mockImplementation(
    (_lang: string, question: string) => `question:${question}`,
  );
});

describe("photo-stage Continue", () => {
  it("asks the question that is actually next instead of finalizing early", async () => {
    // Three photos are on file, but the collector is still several questions
    // away — exactly what a stale `expectingPhoto` session produces, and what
    // used to turn one tap into a finalize attempt that dead-ended onboarding.
    mocks.collect.mockResolvedValue({
      userId: "uuid-1",
      language: "uk",
      completedFields: ["first_name", "age", "gender", "preference", "height"],
      skippedFields: [],
      askedFields: [],
      currentQuestion: "hobbies",
      revision: 6,
      acceptedFields: [],
      rejectedFields: [],
      needsClarification: false,
      unparsedAnswer: false,
    });

    const result = await runAgentTurn(TELEGRAM_ID, { kind: "photos_continue" });

    expect(mocks.collect).toHaveBeenCalledWith(
      TELEGRAM_ID,
      { kind: "photos_continue" },
      expect.anything(),
    );
    expect(result.reply).toBe("question:hobbies");
    expect(result.onboardingComplete).toBe(false);
    // Releasing the stage is the half that actually unsticks the user: while it
    // stays true every following message is swallowed by the upload handler.
    expect(result.expectingPhoto).toBe(false);
    // Nothing was activated.
    expect(mocks.userUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ onboardingStep: "completed" }),
      }),
    );
  });

  it("never prints the finalize guard's internal diagnostic into the chat", async () => {
    // The collector says every question is answered; the guard disagrees. That
    // is a divergence on our side — its message names internal field keys and
    // tells a model to "call finalize_onboarding".
    mocks.collect.mockResolvedValue({
      userId: "uuid-1",
      language: "uk",
      completedFields: ["photos", "context_dump"],
      skippedFields: [],
      askedFields: [],
      currentQuestion: "complete",
      revision: 9,
      acceptedFields: [],
      rejectedFields: [],
      needsClarification: false,
      unparsedAnswer: false,
    });
    // `partnerPreferences: null` makes the guard refuse.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runAgentTurn(TELEGRAM_ID, { kind: "photos_continue" });

    expect(result.onboardingComplete).toBe(false);
    expect(result.reply).not.toContain("finalize_onboarding");
    expect(result.reply).not.toContain("partner_preferences");
    expect(result.expectingPhoto).toBe(false);
    // The diagnostic is still kept — in the log, where it identifies which two
    // notions of "done" drifted apart.
    expect(errors).toHaveBeenCalledWith(
      "[onboarding] finalize refused a complete collector state",
      expect.objectContaining({ error: expect.stringContaining("partner_preferences") }),
    );
    errors.mockRestore();
  });
});
