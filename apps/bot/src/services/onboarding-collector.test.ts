import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextDumpInstruction,
  MAX_AGE,
  MIN_AGE,
} from "@gennety/shared";

vi.mock("../config.js", () => ({
  env: { OPENAI_API_KEY: "test-key" },
}));

// `vi.hoisted` because the mock factory below is lifted above ordinary consts.
const db = vi.hoisted(() => ({
  user: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  profile: { upsert: vi.fn() },
  onboardingProgress: { upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: db,
  Prisma: {},
}));

// Funnel telemetry is best-effort and has its own tests; keep it out of the way.
vi.mock("./onboarding-analytics.js", () => ({
  platformFromTelegramId: () => "telegram",
  recordStepTransition: vi.fn(),
}));

import {
  applyOnboardingFacts,
  backfillCandidates,
  deterministicCandidates,
  extractWithOpenAI,
  isLikelyMetaQuestion,
  nextOnboardingQuestion,
  onboardingNotUnderstoodText,
  onboardingQuestionText,
  onboardingValidationText,
  validateFactCandidate,
  validateFactValue,
  type OnboardingField,
} from "./onboarding-collector.js";
import { recordStepTransition } from "./onboarding-analytics.js";

function valueFor(text: string, field: OnboardingField, question = "height") {
  return deterministicCandidates(
    text,
    question as Parameters<typeof deterministicCandidates>[1],
  ).find((candidate) => candidate.field === field)?.value;
}

describe("onboarding collector parsing", () => {
  it.each([
    ["I'm like 180 centimeters.", 180],
    ["180 cm", 180],
    ["180 см", 180],
    ["180 сантиметров", 180],
    ["Мій зріст 180 сантиметрів", 180],
    ["Ich bin 180 Zentimeter groß", 180],
    ["Mam 180 centymetrów wzrostu", 180],
    ["I'm 5'10\"", 178],
    ["I am 5 feet 10 inches", 178],
  ])("normalizes height from %s", (text, expected) => {
    expect(valueFor(text, "height")).toBe(expected);
  });

  it("extracts several explicit facts from one message", () => {
    const candidates = deterministicCandidates(
      "My name is Alex, I am 22 and I'm looking for women. I'm 180 cm.",
      "first_name_age",
    );
    expect(Object.fromEntries(candidates.map(({ field, value }) => [field, value]))).toMatchObject({
      first_name: "Alex",
      age: 22,
      preference: "women",
      height: 180,
    });
  });

  it("does not read an age out of a height like '183cm'", () => {
    const candidates = deterministicCandidates("I'm 183cm", "height");
    expect(candidates.some(({ field }) => field === "age")).toBe(false);
    expect(candidates.find(({ field }) => field === "height")?.value).toBe(183);
  });

  it("still extracts a real two-digit age", () => {
    expect(
      deterministicCandidates("I'm 24", "first_name_age").find(
        ({ field }) => field === "age",
      )?.value,
    ).toBe(24);
    expect(
      deterministicCandidates("мне 21 год", "first_name_age").find(
        ({ field }) => field === "age",
      )?.value,
    ).toBe(21);
  });

  it("never infers gender from a gendered name", () => {
    const candidates = deterministicCandidates(
      "Меня зовут Руслан, мне 21 год.",
      "first_name_age",
    );
    expect(candidates.some(({ field }) => field === "gender")).toBe(false);
  });

  it("treats no hobbies as a completed empty list", () => {
    expect(valueFor("I don't have any hobbies", "hobbies", "hobbies")).toEqual([]);
    expect(valueFor("У меня нет хобби", "hobbies", "hobbies")).toEqual([]);
  });

  it("rejects extractor output without an exact evidence quote", () => {
    expect(
      validateFactCandidate(
        { field: "height", evidence: "180 cm", value: 180 },
        "I am quite tall.",
      ),
    ).toEqual({ reason: "evidence_not_exact" });
  });

  it("accepts evidence the extractor wrapped in quotation marks", () => {
    // Some extractor models return evidence as a quoted string ("\"I prefer women\"").
    // The guard must strip the wrapping quotes so the LLM-extracted fact is
    // not rejected and the question is not re-asked.
    expect(
      validateFactCandidate(
        { field: "preference", evidence: '"I prefer women"', value: "women" },
        "I prefer women",
      ).candidate?.value,
    ).toBe("women");
    expect(
      validateFactCandidate(
        { field: "first_name", evidence: '"Max"', value: "Max" },
        "Max, 24",
      ).candidate?.value,
    ).toBe("Max");
    expect(
      validateFactCandidate(
        { field: "partner_preferences", evidence: "«someone kind»", value: "someone kind" },
        "someone kind and funny",
      ).candidate?.value,
    ).toBe("someone kind");
  });

  it("still rejects quoted evidence absent from the user message", () => {
    expect(
      validateFactCandidate(
        { field: "height", evidence: '"180 cm"', value: 180 },
        "I am quite tall.",
      ),
    ).toEqual({ reason: "evidence_not_exact" });
  });

  it("accepts a corrected explicit value as a new candidate", () => {
    expect(
      validateFactCandidate(
        { field: "height", evidence: "actually 181 cm", value: 181 },
        "Sorry, actually 181 cm.",
      ).candidate?.value,
    ).toBe(181);
  });

  it("does not consume an explicit height correction as the current hobby answer", () => {
    const candidates = deterministicCandidates("Actually 181 cm.", "hobbies");
    expect(candidates).toEqual([
      expect.objectContaining({ field: "height", value: 181 }),
    ]);
  });

  it("does not capture a clarifying question as a free-text answer", () => {
    expect(
      deterministicCandidates("What do you mean by that?", "partner_preferences"),
    ).toEqual([]);
    expect(deterministicCandidates("в смысле?", "partner_preferences")).toEqual([]);
    expect(
      deterministicCandidates("зачем тебе это знать?", "hobbies"),
    ).toEqual([]);
  });

  it("still captures a genuine free-text answer", () => {
    expect(valueFor("someone kind and funny", "partner_preferences", "partner_preferences")).toBe(
      "someone kind and funny",
    );
    expect(valueFor("I play guitar and hike", "hobbies", "hobbies")).toEqual([
      "I play guitar",
      "hike",
    ]);
  });

  it("flags meta-questions but not real answers", () => {
    expect(isLikelyMetaQuestion("what do you mean?")).toBe(true);
    expect(isLikelyMetaQuestion("men?")).toBe(true);
    expect(isLikelyMetaQuestion("что ты имеешь в виду")).toBe(true);
    expect(isLikelyMetaQuestion("I play guitar and hike")).toBe(false);
    expect(isLikelyMetaQuestion("someone kind and funny")).toBe(false);
    expect(isLikelyMetaQuestion("украинец")).toBe(false);
  });

  it("captures a bare one-word name reply to the name+age question", () => {
    expect(
      deterministicCandidates("Максим", "first_name_age").find(
        ({ field }) => field === "first_name",
      )?.value,
    ).toBe("Максим");
    expect(
      deterministicCandidates("Максим!", "first_name_age").find(
        ({ field }) => field === "first_name",
      )?.value,
    ).toBe("Максим");
  });

  it("does not capture greetings or interjections as a bare name", () => {
    for (const text of ["Привет", "hi", "ок", "Да.", "не знаю", "idk"]) {
      expect(
        deterministicCandidates(text, "first_name_age").some(
          ({ field }) => field === "first_name",
        ),
      ).toBe(false);
    }
  });

  it("does not re-capture a bare word as a name once the name is known", () => {
    expect(
      deterministicCandidates(
        "двадцать",
        "first_name_age",
        new Set<OnboardingField>(["first_name"]),
      ).some(({ field }) => field === "first_name"),
    ).toBe(false);
  });

  it.each([
    ["И тех, и тех", "both"],
    ["і тих, і тих", "both"],
    ["оба", "both"],
    ["both of them", "both"],
    ["Парней", "men"],
    ["девушек.", "women"],
    ["Mężczyzn", "men"],
  ])("understands %s as a direct preference answer", (text, expected) => {
    expect(
      deterministicCandidates(text, "preference").find(
        ({ field }) => field === "preference",
      )?.value,
    ).toBe(expected);
  });

  it("does not read colloquial both-forms outside the preference question", () => {
    expect(
      deterministicCandidates("either tall or kind", "partner_preferences").some(
        ({ field }) => field === "preference",
      ),
    ).toBe(false);
    expect(
      deterministicCandidates("обаятельный и добрый", "partner_preferences").some(
        ({ field }) => field === "preference",
      ),
    ).toBe(false);
  });

  it("does not read a bare 'both' inside free-text as a preference answer", () => {
    // A partner-preferences / vibe answer that merely mentions "both" must NOT
    // clobber the matching-critical `preference` hard filter.
    for (const [text, question] of [
      ["someone who values both career and family", "partner_preferences"],
      ["chilling with both my close friends", "friday_vibe"],
      ["підходить для обох з нас", "partner_preferences"],
    ] as const) {
      expect(
        deterministicCandidates(text, question).some(
          ({ field }) => field === "preference",
        ),
      ).toBe(false);
    }
    // The bare "both" is still a valid direct answer to the preference question.
    expect(
      deterministicCandidates("both", "preference").find(
        ({ field }) => field === "preference",
      )?.value,
    ).toBe("both");
    // An unambiguous "men and women" statement is still captured anywhere.
    expect(
      deterministicCandidates("open to men and women honestly", "partner_preferences").find(
        ({ field }) => field === "preference",
      )?.value,
    ).toBe("both");
  });

  it.each([
    ["Девушка.", "female"],
    ["ж", "female"],
    ["М", "male"],
    ["chłopak", "male"],
  ])("understands %s as a direct gender answer", (text, expected) => {
    expect(
      deterministicCandidates(text, "gender").find(
        ({ field }) => field === "gender",
      )?.value,
    ).toBe(expected);
  });

  it("accepts evidence that differs only by punctuation or extra spacing", () => {
    expect(
      validateFactCandidate(
        { field: "preference", evidence: "и тех и тех", value: "both" },
        "И тех, и тех",
      ).candidate?.value,
    ).toBe("both");
    expect(
      validateFactCandidate(
        { field: "height", evidence: "180 cm", value: 180 },
        "I am  180  cm tall",
      ).candidate?.value,
    ).toBe(180);
  });

  it("still rejects evidence whose words are not in the message", () => {
    expect(
      validateFactCandidate(
        { field: "preference", evidence: "both of them", value: "both" },
        "не знаю пока",
      ),
    ).toEqual({ reason: "evidence_not_exact" });
  });

  it("rejects an enum value mapped from a placeholder answer", () => {
    expect(
      validateFactCandidate(
        { field: "preference", evidence: "не знаю", value: "both" },
        "не знаю",
      ),
    ).toEqual({ reason: "placeholder_answer" });
  });

});

describe("onboarding extractor request", () => {
  it("sends the question text and allowed enum values to the extractor", async () => {
    let requestBody: { messages: Array<{ content: string }> } | undefined;
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ intent: "answer", candidates: [] }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    await extractWithOpenAI(
      "И тех, и тех",
      "preference",
      "ru",
      fetchFn as unknown as typeof fetch,
    );

    const payload = JSON.parse(requestBody!.messages[1].content) as {
      question_text: string;
      allowed_values: string[];
      message: string;
    };
    expect(payload.question_text).toContain("парней");
    expect(payload.allowed_values).toEqual(["men", "women", "both"]);
    expect(payload.message).toBe("И тех, и тех");
  });
});

describe("not-understood feedback", () => {
  it("asks only for the missing half of name+age", () => {
    expect(
      onboardingNotUnderstoodText("ru", "first_name_age", ["first_name"]),
    ).toContain("возраст");
    expect(
      onboardingNotUnderstoodText("ru", "first_name_age", ["age"]),
    ).toContain("имя");
    expect(onboardingNotUnderstoodText("en", "first_name_age")).toContain(
      "Alex, 21",
    );
  });

  it("lists the preference options in the user's language", () => {
    expect(onboardingNotUnderstoodText("ru", "preference")).toContain("обоих");
  });

  it("returns null for stages that do not expect free text", () => {
    expect(onboardingNotUnderstoodText("en", "photos")).toBeNull();
    expect(onboardingNotUnderstoodText("en", "context_dump")).toBeNull();
    expect(onboardingNotUnderstoodText("en", "complete")).toBeNull();
  });

  it.each(["en", "ru", "uk", "de", "pl"] as const)(
    "has a hint for every parseable question in %s",
    (language) => {
      for (const question of [
        "first_name_age",
        "gender",
        "preference",
        "height",
      "relationship_intent",
        "hobbies",
        "partner_preferences",
        "ai_memory",
      ] as const) {
        expect(onboardingNotUnderstoodText(language, question)).toBeTruthy();
      }
    },
  );
});

describe("onboarding collector routing", () => {
  it("backfills the Paulie history without inventing hobbies", () => {
    const history = [
      { role: "assistant", content: "What’s your first name and how old are you?" },
      { role: "user", content: "My name is Paulie and I am 20." },
      { role: "assistant", content: "Are you a guy or a girl?" },
      { role: "user", content: "I'm a girl." },
      { role: "assistant", content: "Who are you into: guys, girls, or both?" },
      { role: "user", content: "I'm looking for boys" },
      { role: "assistant", content: "How tall are you in cm?" },
      { role: "user", content: "I'm like 180 centimeters." },
      {
        role: "assistant",
        content: "What kind of person are you looking for in a partner?",
      },
      { role: "user", content: "I'm looking for good humor." },
      { role: "user", content: "[Album uploaded: 2 verified photos]" },
    ];

    const result = backfillCandidates(history);
    const values = Object.fromEntries(
      result.candidates.map(({ field, value }) => [field, value]),
    );
    expect(values).toMatchObject({
      first_name: "Paulie",
      age: 20,
      gender: "female",
      preference: "men",
      height: 180,
      partner_preferences: "I'm looking for good humor.",
    });
    expect(values).not.toHaveProperty("hobbies");
  });

  it("routes deterministically to the first genuinely missing field", () => {
    const completed = new Set<OnboardingField>([
      "first_name",
      "age",
      "gender",
      "preference",
      "height",
      "relationship_intent",
      "partner_preferences",
      "ai_memory",
      "context_dump",
      "photos",
    ]);
    expect(
      nextOnboardingQuestion({
        completed,
        skipped: new Set(),
        asked: new Set(),
      }),
    ).toBe("hobbies");
  });

  it("asks the vibe questions after the profile fields and before the Magic Prompt", () => {
    const completedThroughProfile = new Set<OnboardingField>([
      "first_name",
      "age",
      "gender",
      "preference",
      "height",
      "relationship_intent",
      "hobbies",
      "partner_preferences",
    ]);
    expect(
      nextOnboardingQuestion({
        completed: completedThroughProfile,
        skipped: new Set(),
        asked: new Set(),
      }),
    ).toBe("friday_vibe");
    expect(
      nextOnboardingQuestion({
        completed: new Set([...completedThroughProfile, "friday_vibe"]),
        skipped: new Set(),
        asked: new Set(),
      }),
    ).toBe("vibe_focus");
    expect(
      nextOnboardingQuestion({
        completed: new Set([...completedThroughProfile, "friday_vibe", "vibe_focus"]),
        skipped: new Set(),
        asked: new Set(),
      }),
    ).toBe("ai_memory");
  });

  it("skips the Magic Prompt straight to photos when AI-memory is declined", () => {
    // Regression: a declined AI-memory turn must land on `photos`, not stall
    // on `context_dump` — the mobile hybrid-chat photo stage keys off
    // currentQuestion === "photos" (expectingPhoto + photo_upload uiHint).
    const throughAiMemory = new Set<OnboardingField>([
      "first_name",
      "age",
      "gender",
      "preference",
      "height",
      "relationship_intent",
      "hobbies",
      "partner_preferences",
      "friday_vibe",
      "vibe_focus",
      "ai_memory",
      "context_dump",
    ]);
    expect(
      nextOnboardingQuestion({
        completed: throughAiMemory,
        skipped: new Set<OnboardingField>(["context_dump"]),
        asked: new Set(),
      }),
    ).toBe("photos");
  });

  it("captures and validates free-text vibe answers", () => {
    const friday = deterministicCandidates(
      "a quiet dinner at home then a film with one close friend",
      "friday_vibe",
    ).find((c) => c.field === "friday_vibe");
    expect(friday?.value).toBe("a quiet dinner at home then a film with one close friend");
    expect(validateFactCandidate(friday!, "a quiet dinner at home then a film with one close friend").candidate?.field).toBe("friday_vibe");

    const focus = deterministicCandidates("who's with me", "vibe_focus").find(
      (c) => c.field === "vibe_focus",
    );
    expect(focus?.value).toBe("who's with me");

    // A confused question is not banked as the answer.
    expect(deterministicCandidates("what do you mean?", "friday_vibe")).toEqual([]);
  });

  it("does not repeat the known half of the name and age question", () => {
    expect(onboardingQuestionText("ru", "first_name_age", ["first_name"])).toBe(
      "Сколько тебе лет?",
    );
    expect(onboardingQuestionText("en", "first_name_age", ["age"])).toBe(
      "What should I call you?",
    );
  });

  it("explains out-of-range age instead of silently repeating the age question", () => {
    expect(
      onboardingValidationText("ru", [
        { field: "age", reason: "age_out_of_range" },
      ]),
    ).toContain(`${MIN_AGE}-${MAX_AGE}`);
  });

  it.each(["en", "ru", "uk", "de", "pl"] as const)(
    "has server-owned text for every question in %s",
    (language) => {
      expect(onboardingQuestionText(language, "gender")).not.toHaveLength(0);
      expect(onboardingQuestionText(language, "photos")).not.toHaveLength(0);
    },
  );

  it("explains why the Magic Prompt is needed before asking for the AI response", () => {
    const text = onboardingQuestionText("en", "context_dump");

    expect(text).toContain("Gennety analyzes your conversations");
    expect(text).toContain("psychological profile");
    expect(text).toContain("We interview all other users in exactly the same way");
  });

  it.each(["en", "ru", "uk", "de", "pl"] as const)(
    "uses the shared canonical context prompt instruction in %s",
    (language) => {
      expect(onboardingQuestionText(language, "context_dump")).toBe(
        contextDumpInstruction(language),
      );
    },
  );
});

/**
 * `applyOnboardingFacts` — the structured save path used by the Telegram
 * Onboarding Mini App's own profile screens (PRODUCT_SPEC §1.3). The point of
 * the tests below is that it goes through the SAME machinery as a chat answer:
 * canonical columns, `onboarding_progress` under its revision guard, and the
 * funnel row — so the chat picks up on the first field it never delivered.
 */
describe("applyOnboardingFacts", () => {
  const TELEGRAM_ID = 5986970093n;

  function collectorUser(overrides: Record<string, unknown> = {}) {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      telegramId: TELEGRAM_ID,
      language: "en",
      firstName: null,
      age: null,
      gender: null,
      preference: null,
      aiMemoryExportPreference: "declined",
      messageHistory: [],
      profile: {
        height: null,
        hobbies: [],
        partnerPreferences: null,
        fridayVibeText: null,
        vibeFocusText: null,
        psychologicalSummary: null,
        photos: [],
      },
      onboardingProgress: {
        completedFields: [],
        skippedFields: [],
        askedFields: [],
        currentQuestion: "first_name_age",
        collectorVersion: 1,
        revision: 4,
        // Already backfilled, so `ensureProgress` is a no-op read.
        backfilledAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      ...overrides,
    };
  }

  /** Stand up the fake DB and return the row the write path ends up seeing. */
  function primeDb(user: ReturnType<typeof collectorUser>) {
    const state = { user, progressWrite: null as Record<string, unknown> | null };
    db.user.findUniqueOrThrow.mockImplementation(async () => state.user);
    db.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.user = { ...state.user, ...data };
      return state.user;
    });
    db.profile.upsert.mockImplementation(
      async ({ update }: { update: Record<string, unknown> }) => {
        state.user = {
          ...state.user,
          profile: { ...(state.user.profile ?? {}), ...update },
        } as typeof state.user;
        return state.user.profile;
      },
    );
    db.onboardingProgress.updateMany.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        state.progressWrite = data;
        state.user = {
          ...state.user,
          onboardingProgress: {
            ...(state.user.onboardingProgress ?? {}),
            ...data,
            revision: 5,
          },
        } as typeof state.user;
        return { count: 1 };
      },
    );
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<void>) => fn(db));
    return state;
  }

  beforeEach(() => {
    db.user.findUniqueOrThrow.mockReset();
    db.user.update.mockReset();
    db.profile.upsert.mockReset();
    db.onboardingProgress.updateMany.mockReset();
    db.$transaction.mockReset();
    vi.mocked(recordStepTransition).mockClear();
  });

  it("writes the canonical columns and advances the question", async () => {
    const state = primeDb(collectorUser({ firstName: "Alice" }));

    const snapshot = await applyOnboardingFacts(TELEGRAM_ID, { age: 24 });

    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ age: 24 }) }),
    );
    // Name + age complete `first_name_age`, so the next question is gender.
    expect(state.progressWrite?.currentQuestion).toBe("gender");
    expect(snapshot.acceptedFields).toEqual(["age"]);
    expect(snapshot.rejectedFields).toEqual([]);
  });

  it("writes height onto the profile row and moves on to the intent screen", async () => {
    const state = primeDb(
      collectorUser({
        firstName: "Alice",
        age: 24,
        gender: "female",
        preference: "men",
      }),
    );

    const snapshot = await applyOnboardingFacts(TELEGRAM_ID, { height: 170 });

    expect(db.profile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ height: 170 }) }),
    );
    expect(state.progressWrite?.currentQuestion).toBe("relationship_intent");
    expect(snapshot.currentQuestion).toBe("relationship_intent");
  });

  it("writes the relationship intent onto the profile row", async () => {
    const state = primeDb(
      collectorUser({
        firstName: "Alice",
        age: 24,
        gender: "female",
        preference: "men",
      }),
    );

    const snapshot = await applyOnboardingFacts(TELEGRAM_ID, {
      height: 170,
      relationship_intent: ["longterm", "spark"],
    });

    // Stored as a canonical SET: deduplicated and sorted by axis position, so
    // the row never depends on which option was tapped first.
    expect(db.profile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          relationshipIntents: ["spark", "longterm"],
        }),
      }),
    );
    // The intent is the LAST Mini App screen, so answering it hands the chat
    // its first question rather than another screen.
    expect(state.progressWrite?.currentQuestion).toBe("hobbies");
    expect(snapshot.currentQuestion).toBe("hobbies");
  });

  it("rejects an intent outside the axis and writes nothing", async () => {
    // All-or-nothing: a value the matching engine could not read must never be
    // stored, and must not half-save the screen either.
    primeDb(collectorUser({ firstName: "Alice", age: 24, gender: "female", preference: "men" }));

    const snapshot = await applyOnboardingFacts(TELEGRAM_ID, {
      height: 170,
      relationship_intent: "situationship",
    });

    expect(db.profile.upsert).not.toHaveBeenCalled();
    expect(snapshot.rejectedFields).toEqual([
      { field: "relationship_intent", reason: "invalid_relationship_intent" },
    ]);
  });

  it("accepts a whole screen set at once", async () => {
    const state = primeDb(collectorUser());

    await applyOnboardingFacts(TELEGRAM_ID, {
      first_name: "Alice",
      age: 24,
      gender: "female",
      preference: "men",
      height: 170,
      relationship_intent: "longterm",
    });

    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstName: "Alice",
          age: 24,
          gender: "female",
          preference: "men",
        }),
      }),
    );
    expect(state.progressWrite?.currentQuestion).toBe("hobbies");
  });

  it.each([
    ["age below the floor", { age: 12 }, "age_out_of_range"],
    ["age above the ceiling", { age: 99 }, "age_out_of_range"],
    ["height off the scale", { height: 300 }, "height_out_of_range"],
    ["a name that is not one", { first_name: "A1" }, "invalid_name"],
    ["a gender outside the enum", { gender: "other" }, "invalid_gender"],
    ["a preference outside the enum", { preference: "everyone" }, "invalid_preference"],
  ])("rejects %s and writes nothing", async (_label, facts, reason) => {
    primeDb(collectorUser());

    const snapshot = await applyOnboardingFacts(TELEGRAM_ID, facts);

    expect(snapshot.rejectedFields[0]?.reason).toBe(reason);
    expect(snapshot.acceptedFields).toEqual([]);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.profile.upsert).not.toHaveBeenCalled();
    expect(db.onboardingProgress.updateMany).not.toHaveBeenCalled();
  });

  it("is all-or-nothing: one bad value blocks the good ones beside it", async () => {
    primeDb(collectorUser());

    const snapshot = await applyOnboardingFacts(TELEGRAM_ID, {
      first_name: "Alice",
      age: 7,
    });

    expect(snapshot.rejectedFields).toHaveLength(1);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("retries a revision conflict instead of losing the answer", async () => {
    const state = primeDb(collectorUser({ firstName: "Alice" }));
    let attempts = 0;
    db.onboardingProgress.updateMany.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        attempts += 1;
        if (attempts === 1) return { count: 0 }; // someone else moved the row
        state.progressWrite = data;
        return { count: 1 };
      },
    );

    const snapshot = await applyOnboardingFacts(TELEGRAM_ID, { age: 24 });

    expect(attempts).toBe(2);
    expect(snapshot.acceptedFields).toEqual(["age"]);
  });

  it("records one funnel row per real step transition", async () => {
    primeDb(collectorUser());

    // Name alone leaves `first_name_age` current — nothing resolved yet.
    await applyOnboardingFacts(TELEGRAM_ID, { first_name: "Alice" });
    expect(recordStepTransition).not.toHaveBeenCalled();

    await applyOnboardingFacts(TELEGRAM_ID, { age: 24 });
    expect(recordStepTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: { step: "first_name_age", kind: "answered" },
        askedNext: "gender",
        platform: "telegram",
      }),
    );
  });
});

describe("validateFactValue", () => {
  it("applies the same bounds the free-text path uses, without needing evidence", () => {
    expect(validateFactValue("age", MIN_AGE - 1).reason).toBe("age_out_of_range");
    expect(validateFactValue("age", MAX_AGE).value).toBe(MAX_AGE);
    expect(validateFactValue("height", 139).reason).toBe("height_out_of_range");
    expect(validateFactValue("height", 170.4).value).toBe(170);
    expect(validateFactValue("first_name", "  Alice  ").value).toBe("Alice");
  });

  it("refuses the synthetic fields a client must never set directly", () => {
    expect(validateFactValue("photos", 3).reason).toBe("synthetic_field_not_extractable");
    expect(validateFactValue("context_dump", "x").reason).toBe(
      "synthetic_field_not_extractable",
    );
  });
});
