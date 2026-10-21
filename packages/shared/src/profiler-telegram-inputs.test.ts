import { describe, expect, it } from "vitest";
import { contextualProfilerQuestion } from "./profiler-context-questions.js";
import { profilerQuestionBank, profilerQuestionById } from "./profiler-questions.js";
import { composeProfilerAnswerText, profilerQuestionInput, profilerTelegramQuestionInput } from "./profiler-inputs.js";

const cardIds = ["f_date_spots", "f_comm_style", "f_chronotype", "f_sport_pref", "f_initiative", "f_flowers", "f_pets", "m_sport", "m_chronotype", "m_planner", "m_pets"];
describe("Telegram mixed Profiler", () => {
  it("offers exactly the approved 11 cards and leaves 14 questions free text", () => {
    const bank = [...profilerQuestionBank("female"), ...profilerQuestionBank("male")];
    expect(bank.filter(q => profilerTelegramQuestionInput(q)).map(q => q.id).sort()).toEqual([...cardIds].sort());
    expect(bank.filter(q => !profilerTelegramQuestionInput(q))).toHaveLength(14);
  });
  it("keeps the native pilot unchanged", () => {
    expect(profilerQuestionInput(profilerQuestionById("f_date_spots")!)).toBeNull();
    for (const id of ["f_travel", "m_travel"]) {
      expect(profilerQuestionInput(profilerQuestionById(id)!)).not.toBeNull();
      expect(profilerTelegramQuestionInput(profilerQuestionById(id)!)).toBeNull();
    }
  });
  it("keeps the fresh topic open but uses cards for contextual decisions", () => {
    const key = "3f2b8c4e-9a1d-4e5f-8b7c-6d5e4f3a2b1c";
    expect(profilerTelegramQuestionInput(contextualProfilerQuestion("male", "topic", key)!)).toBeNull();
    expect(profilerTelegramQuestionInput(contextualProfilerQuestion("female", "format", key)!)?.closed).toBe(true);
  });
  it("validates and localizes multiple places plus personal detail without accepting them in iOS", () => {
    const question = profilerQuestionById("f_date_spots")!;
    const input = profilerTelegramQuestionInput(question);
    for (const language of ["en", "ru", "uk", "de", "pl"] as const) {
      const result = composeProfilerAnswerText(question, ["coffee", "walk"], "my favourite place", language, 1000, undefined, input);
      expect(result).toMatchObject({ ok: true, source: "both", optionIds: ["coffee", "walk"] });
      if (result.ok) expect(result.answerText).toContain(input!.options[0]!.text[language]);
    }
    expect(composeProfilerAnswerText(question, ["forged"], "", "en", 1000, undefined, input).ok).toBe(false);
    expect(composeProfilerAnswerText(question, ["coffee"], "", "en", 1000).ok).toBe(false);
  });
});
