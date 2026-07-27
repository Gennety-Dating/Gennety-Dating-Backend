import { describe, it, expect } from "vitest";
import {
  profilerQuestionBank,
  profilerQuestionById,
  profilerQuestionText,
  profilerPriorityWeight,
  isRefreshableProfilerQuestion,
  scoreProfilerAnswers,
  formatProfilerAnswersBlock,
} from "./profiler-questions.js";

describe("profilerQuestionBank", () => {
  it("returns priority-ordered, gender-specific banks", () => {
    // Array order IS the ask order, so the real invariant is monotonically
    // non-increasing priority — asserted instead of a fixed length, which only
    // ever forced a mechanical edit whenever a question was added.
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (const gender of ["female", "male"] as const) {
      const bank = profilerQuestionBank(gender);
      expect(bank.length).toBeGreaterThan(5);
      expect(bank[0].priority).toBe("high");
      expect(bank[bank.length - 1].priority).toBe("low");
      for (let i = 1; i < bank.length; i++) {
        expect(rank[bank[i].priority], `${bank[i].id} out of order`).toBeGreaterThanOrEqual(
          rank[bank[i - 1].priority],
        );
      }
      expect(bank.every((q) => q.gender === gender)).toBe(true);
    }
  });

  it("carries situational questions that are re-asked each cycle", () => {
    // Without refreshables the bank runs dry in a couple of days and the
    // Profiler goes silent; these are what keep the icebreaker fuel current.
    for (const gender of ["female", "male"] as const) {
      const refreshable = profilerQuestionBank(gender).filter((q) =>
        isRefreshableProfilerQuestion(q),
      );
      expect(refreshable.length, `${gender} bank has no refreshable question`).toBeGreaterThan(0);
    }
  });

  it("treats a question without an explicit policy as ask-once", () => {
    expect(isRefreshableProfilerQuestion(profilerQuestionById("f_chronotype")!)).toBe(false);
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
