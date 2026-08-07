import { describe, it, expect } from "vitest";
import { isProfilerRefusal } from "./profiler-intent.js";

describe("isProfilerRefusal", () => {
  it.each([
    "не хочу",
    "не хочу отвечать",
    "пропусти",
    "отстань",
    "потом",
    "не хочу відповідати",
    "пропустити",
    "skip",
    "not now",
    "i don't want to answer",
    "keine lust",
    "nicht jetzt",
    "nie chcę",
    "pomiń",
  ])("treats %j as a refusal", (text) => {
    expect(isProfilerRefusal(text)).toBe(true);
  });

  it("normalizes case, trailing punctuation and inner whitespace", () => {
    expect(isProfilerRefusal("  Не   хочу отвечать...  ")).toBe(true);
    expect(isProfilerRefusal("SKIP!")).toBe(true);
  });

  // The single most important negative case. A large part of the question bank
  // is answerable with a bare "no" ("do you play any sport?", "are you a
  // morning person?"), so classifying it as a refusal would throw away a real
  // answer AND pause the batch on someone who was cooperating.
  it.each(["нет", "ні", "no", "nein", "nie"])(
    "does NOT treat the bare negative %j as a refusal",
    (text) => {
      expect(isProfilerRefusal(text)).toBe(false);
    },
  );

  // Whole-utterance matching is what makes a false positive impossible: the
  // refusal phrase has to BE the message, not appear inside it.
  it.each([
    "не хочу в кино, а вот на концерт хочу",
    "не хочу спорт, зато читаю много",
    "skip rope is my whole cardio routine",
    "потом расскажу подробнее, но если коротко — бегаю по утрам",
  ])("does NOT treat %j as a refusal", (text) => {
    expect(isProfilerRefusal(text)).toBe(false);
  });

  it("ignores an empty or over-long message", () => {
    expect(isProfilerRefusal("   ")).toBe(false);
    expect(isProfilerRefusal("не хочу ".repeat(20))).toBe(false);
  });
});
