import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "./types.js";
import { profilerQuestionBank, profilerQuestionById } from "./profiler-questions.js";
import { contextualProfilerQuestion } from "./profiler-context-questions.js";
import {
  PROFILER_SCALE_STEP_IDS,
  composeProfilerAnswerText,
  profilerBankInputIds,
  profilerQuestionInput,
} from "./profiler-inputs.js";

const q = (id: string) => profilerQuestionById(id)!;

describe("profiler quick-answer inputs", () => {
  it("every pilot id is a bank question that takes words, not a picture", () => {
    for (const id of profilerBankInputIds()) {
      const question = q(id);
      expect(question, id).toBeDefined();
      expect(question.context, id).toBeUndefined();
      expect(question.acceptsImage, id).toBeFalsy();
    }
  });

  it("the questions whose value is the person's own words stay text only", () => {
    for (const id of ["f_turnoffs", "f_humor", "m_humor", "m_surprise", "m_friends_say", "m_passions"]) {
      expect(profilerQuestionInput(q(id)), id).toBeNull();
    }
  });

  it("every option has unique id and text in every language", () => {
    for (const gender of ["female", "male"] as const) {
      for (const question of profilerQuestionBank(gender)) {
        const input = profilerQuestionInput(question);
        if (!input) continue;
        const ids = input.options.map((o) => o.id);
        expect(new Set(ids).size, question.id).toBe(ids.length);
        for (const option of input.options) {
          for (const lang of SUPPORTED_LANGUAGES) {
            expect(option.text[lang]?.trim(), `${question.id}.${option.id}.${lang}`).toBeTruthy();
          }
        }
        if (input.poles) {
          for (const lang of SUPPORTED_LANGUAGES) {
            expect(input.poles.from[lang]?.trim()).toBeTruthy();
            expect(input.poles.to[lang]?.trim()).toBeTruthy();
          }
        }
      }
    }
  });

  it("shapes follow their kind: seven scale steps, a pair of photos, a photo ribbon", () => {
    for (const id of profilerBankInputIds()) {
      const input = profilerQuestionInput(q(id))!;
      expect(input.closed, id).toBe(false);
      if (input.kind === "scale") {
        expect(input.options.map((o) => o.id)).toEqual([...PROFILER_SCALE_STEP_IDS]);
        expect(input.poles).toBeDefined();
        expect(input.multiple).toBe(false);
      }
      if (input.kind === "pair") {
        expect(input.options).toHaveLength(2);
        expect(input.options.every((o) => o.image)).toBe(true);
        expect(input.multiple).toBe(false);
      }
      if (input.kind === "photos") {
        expect(input.options.filter((o) => o.image).length).toBeGreaterThanOrEqual(4);
      }
    }
    expect(profilerQuestionInput(q("f_flowers"))!.kind).toBe("photos");
    expect(profilerQuestionInput(q("f_travel"))!.kind).toBe("pair");
    expect(profilerQuestionInput(q("m_chronotype"))!.kind).toBe("scale");
  });

  it("a contextual question is closed chips from its own options", () => {
    const question = contextualProfilerQuestion("female", "format", "11111111-1111-1111-1111-111111111111")!;
    const input = profilerQuestionInput(question)!;
    expect(input).toMatchObject({ kind: "chips", closed: true, multiple: false });
    expect(input.options).toBe(question.options);
  });
});

describe("composeProfilerAnswerText", () => {
  const flowers = q("f_flowers");

  it("taps alone become the options' text, in tap order", () => {
    expect(composeProfilerAnswerText(flowers, ["roses", "peony"], "", "ru", 1000)).toEqual({
      ok: true,
      answerText: "Розы, Пионы",
      optionIds: ["roses", "peony"],
      source: "tap",
    });
  });

  it("text that already names every tapped option is kept as written", () => {
    const r = composeProfilerAnswerText(flowers, ["peony"], "Пионы, но не в горшке", "ru", 1000, "both");
    expect(r).toMatchObject({ ok: true, answerText: "Пионы, но не в горшке", source: "both" });
  });

  it("text that does not name the option is prefixed with it — a scale step plus words", () => {
    const r = composeProfilerAnswerText(q("f_chronotype"), ["to_2"], "зависит от дня", "ru", 1000);
    expect(r).toMatchObject({ ok: true, answerText: "Скорее сова. зависит от дня", source: "both" });
  });

  it("a 'tap' claim with the app's own labels in the field stays tap", () => {
    const r = composeProfilerAnswerText(flowers, ["peony", "tulip"], "Пионы, тюльпаны", "ru", 1000, "tap");
    expect(r).toMatchObject({ ok: true, answerText: "Пионы, тюльпаны", source: "tap" });
  });

  it("words only stay text", () => {
    expect(composeProfilerAnswerText(flowers, [], "  ирисы ", "ru", 1000)).toEqual({
      ok: true,
      answerText: "ирисы",
      optionIds: [],
      source: "text",
    });
  });

  it("refuses an unknown option, two options on a single-choice input, and nothing at all", () => {
    expect(composeProfilerAnswerText(flowers, ["orchid"], "", "en", 1000)).toEqual({ ok: false, error: "unknown_option" });
    expect(composeProfilerAnswerText(q("f_travel"), ["sea", "mountains"], "", "en", 1000)).toEqual({
      ok: false,
      error: "too_many_options",
    });
    expect(composeProfilerAnswerText(q("f_turnoffs"), ["x"], "", "en", 1000)).toEqual({ ok: false, error: "unknown_option" });
    expect(composeProfilerAnswerText(flowers, [], "  ", "en", 1000)).toEqual({ ok: false, error: "empty_answer" });
  });

  it("caps the stored text", () => {
    const r = composeProfilerAnswerText(flowers, ["roses"], "x".repeat(50), "en", 20);
    expect(r.ok && r.answerText.length).toBe(20);
  });
});
