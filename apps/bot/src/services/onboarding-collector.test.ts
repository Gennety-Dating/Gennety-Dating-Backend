import { describe, expect, it, vi } from "vitest";
import {
  contextDumpInstruction,
  MAX_AGE,
  MIN_AGE,
} from "@gennety/shared";

vi.mock("../config.js", () => ({
  env: { OPENAI_API_KEY: "test-key" },
}));

import {
  backfillCandidates,
  deterministicCandidates,
  extractWithOpenAI,
  isLikelyMetaQuestion,
  nextOnboardingQuestion,
  onboardingNotUnderstoodText,
  onboardingQuestionText,
  onboardingValidationText,
  validateFactCandidate,
  type OnboardingField,
} from "./onboarding-collector.js";

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
    // gpt-5.4-mini returns evidence as a quoted string ("\"I prefer women\"").
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
    expect(deterministicCandidates("в смысле?", "ethnicity")).toEqual([]);
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

  it("treats inflected skip phrases as a skip, not an ethnicity answer", () => {
    expect(deterministicCandidates("пропустить", "ethnicity")).toEqual([]);
    expect(deterministicCandidates("überspringen", "ethnicity")).toEqual([]);
    expect(deterministicCandidates("pomiń", "ethnicity")).toEqual([]);
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
        "hobbies",
        "partner_preferences",
        "ethnicity",
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
      { role: "assistant", content: "What’s your ethnicity or nationality?" },
      { role: "user", content: "I'm Ukrainian" },
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
      ethnicity: "I'm Ukrainian",
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
      "partner_preferences",
      "ethnicity",
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

  it("asks the vibe questions after ethnicity and before the Magic Prompt", () => {
    const completedThroughEthnicity = new Set<OnboardingField>([
      "first_name",
      "age",
      "gender",
      "preference",
      "height",
      "hobbies",
      "partner_preferences",
      "ethnicity",
    ]);
    expect(
      nextOnboardingQuestion({
        completed: completedThroughEthnicity,
        skipped: new Set(),
        asked: new Set(),
      }),
    ).toBe("friday_vibe");
    expect(
      nextOnboardingQuestion({
        completed: new Set([...completedThroughEthnicity, "friday_vibe"]),
        skipped: new Set(),
        asked: new Set(),
      }),
    ).toBe("vibe_focus");
    expect(
      nextOnboardingQuestion({
        completed: new Set([...completedThroughEthnicity, "friday_vibe", "vibe_focus"]),
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
      "hobbies",
      "partner_preferences",
      "ethnicity",
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
      expect(onboardingQuestionText(language, "ethnicity")).not.toHaveLength(0);
      expect(onboardingQuestionText(language, "photos")).not.toHaveLength(0);
    },
  );

  it("uses natural Russian wording for the optional origin question", () => {
    const text = onboardingQuestionText("ru", "ethnicity");

    expect(text).toBe(
      "Как ты описываешь своё происхождение или национальность? Можно пропустить",
    );
    expect(text).not.toContain("бэкграунд");
  });

  it("explains why the Magic Prompt is needed before asking for the AI response", () => {
    const text = onboardingQuestionText("en", "context_dump");

    // Evidence-first copy: it promises better matches from supported signals,
    // tells the user's AI not to fill gaps (empty sections are fine), and notes
    // the same rule applies to everyone.
    expect(text).toContain("Gennety uses supported signals from your conversations");
    expect(text).toContain("not to fill gaps");
    expect(text).toContain("The same rule applies to every user");
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
