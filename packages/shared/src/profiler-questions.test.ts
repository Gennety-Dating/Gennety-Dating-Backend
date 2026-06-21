import { describe, it, expect } from "vitest";
import {
  profilerQuestionBank,
  profilerQuestionById,
  profilerQuestionText,
  profilerPriorityWeight,
  scoreProfilerAnswers,
  formatProfilerAnswersBlock,
} from "./profiler-questions.js";

describe("profilerQuestionBank", () => {
  it("returns priority-ordered, gender-specific banks", () => {
    const female = profilerQuestionBank("female");
    const male = profilerQuestionBank("male");
    expect(female.length).toBe(7);
    expect(male.length).toBe(5);
    // High-priority questions lead each bank.
    expect(female[0].priority).toBe("high");
    expect(male[0].priority).toBe("high");
    // Last is the low-priority media question.
    expect(female[female.length - 1].priority).toBe("low");
    expect(male[male.length - 1].priority).toBe("low");
  });

  it("returns empty for unknown gender", () => {
    expect(profilerQuestionBank(null)).toEqual([]);
  });

  it("every question has all five language translations", () => {
    for (const q of [...profilerQuestionBank("female"), ...profilerQuestionBank("male")]) {
      for (const lang of ["en", "ru", "uk", "de", "pl"] as const) {
        expect(q.text[lang], `${q.id}/${lang}`).toBeTruthy();
      }
    }
  });

  it("ids are unique across both banks", () => {
    const ids = [...profilerQuestionBank("female"), ...profilerQuestionBank("male")].map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("profilerQuestionById / text", () => {
  it("finds a question by id and localizes with en fallback", () => {
    const q = profilerQuestionById("f_date_spots");
    expect(q?.gender).toBe("female");
    expect(profilerQuestionText(q!, "ru")).toContain("свидани");
    expect(profilerQuestionText(q!, "en")).toMatch(/first date/i);
  });

  it("returns undefined for an unknown id", () => {
    expect(profilerQuestionById("nope")).toBeUndefined();
  });
});

describe("profilerPriorityWeight", () => {
  it("maps priorities to the configured weights", () => {
    expect(profilerPriorityWeight("high")).toBe(1.0);
    expect(profilerPriorityWeight("medium")).toBe(0.5);
    expect(profilerPriorityWeight("low")).toBe(0.2);
  });
});

describe("scoreProfilerAnswers", () => {
  it("drops skipped/blank rows, joins to the bank, sorts by weight desc", () => {
    const scored = scoreProfilerAnswers([
      { questionId: "f_media", answerText: "a podcast" }, // low 0.2
      { questionId: "f_date_spots", answerText: "rooftop cafes" }, // high 1.0
      { questionId: "f_turnoffs", answerText: "" }, // blank → dropped
      { questionId: "f_shared_interests", answerText: "  " }, // whitespace → dropped
      { questionId: "unknown_q", answerText: "x" }, // not in bank → dropped
    ]);
    expect(scored.map((s) => s.question.id)).toEqual(["f_date_spots", "f_media"]);
    expect(scored[0].weight).toBe(1.0);
    expect(scored[1].weight).toBe(0.2);
  });
});

describe("formatProfilerAnswersBlock", () => {
  it("returns null when there are no scored answers", () => {
    expect(formatProfilerAnswersBlock([], "en")).toBeNull();
  });

  it("renders weight-tagged lines in the reader's language", () => {
    const scored = scoreProfilerAnswers([
      { questionId: "m_passions", answerText: "space and chess" },
    ]);
    const block = formatProfilerAnswersBlock(scored, "en");
    expect(block).toContain("[weight 1.0]");
    expect(block).toContain("space and chess");
  });
});
