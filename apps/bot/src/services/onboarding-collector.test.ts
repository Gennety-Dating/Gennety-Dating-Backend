import { describe, expect, it } from "vitest";
import {
  backfillCandidates,
  deterministicCandidates,
  nextOnboardingQuestion,
  onboardingQuestionText,
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

  it("does not repeat the known half of the name and age question", () => {
    expect(onboardingQuestionText("ru", "first_name_age", ["first_name"])).toBe(
      "Сколько тебе лет?",
    );
    expect(onboardingQuestionText("en", "first_name_age", ["age"])).toBe(
      "What should I call you?",
    );
  });

  it.each(["en", "ru", "uk", "de", "pl"] as const)(
    "has server-owned text for every question in %s",
    (language) => {
      expect(onboardingQuestionText(language, "gender")).not.toHaveLength(0);
      expect(onboardingQuestionText(language, "ethnicity")).not.toHaveLength(0);
      expect(onboardingQuestionText(language, "photos")).not.toHaveLength(0);
    },
  );
});
