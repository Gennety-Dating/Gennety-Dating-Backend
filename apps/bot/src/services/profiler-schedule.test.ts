import { describe, it, expect } from "vitest";
import { profilerQuestionBank } from "@gennety/shared";
import {
  batchSizeFor,
  isQuietHourLocal,
  isRushMode,
  nextWindowAt,
  resolveZone,
  selectNextProfilerQuestion,
  shouldCaptureProfilerAnswer,
  skipTransition,
  type ProfilerAnswerRow,
} from "./profiler-schedule.js";

const KYIV = "Europe/Kyiv";

function kyivHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: KYIV,
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .find((p) => p.type === "hour")!.value,
  ) % 24;
}

describe("resolveZone", () => {
  it("falls back to Europe/Kyiv for null/blank", () => {
    expect(resolveZone(null)).toBe(KYIV);
    expect(resolveZone("  ")).toBe(KYIV);
    expect(resolveZone("America/New_York")).toBe("America/New_York");
  });
});

describe("nextWindowAt", () => {
  it("lands on the next 09:00 or 18:00 local window", () => {
    // 2026-06-10 is summer (Kyiv = UTC+3).
    // 07:00 Kyiv → next window is 09:00 same day.
    const at7 = new Date("2026-06-10T04:00:00Z"); // 07:00 Kyiv
    expect(kyivHour(nextWindowAt(at7, KYIV))).toBe(9);

    // 10:00 Kyiv → next window 18:00 same day.
    const at10 = new Date("2026-06-10T07:00:00Z");
    expect(kyivHour(nextWindowAt(at10, KYIV))).toBe(18);

    // 19:00 Kyiv → next window 09:00 next day.
    const at19 = new Date("2026-06-10T16:00:00Z");
    const w = nextWindowAt(at19, KYIV);
    expect(kyivHour(w)).toBe(9);
    expect(w.getTime()).toBeGreaterThan(at19.getTime());
  });

  it("is always strictly in the future", () => {
    const now = new Date("2026-06-10T06:00:00Z");
    expect(nextWindowAt(now, KYIV).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("isQuietHourLocal", () => {
  it("treats [23:00, 09:00) local as quiet", () => {
    expect(isQuietHourLocal(new Date("2026-06-10T00:00:00Z"), KYIV)).toBe(true); // 03:00 Kyiv
    expect(isQuietHourLocal(new Date("2026-06-10T07:00:00Z"), KYIV)).toBe(false); // 10:00 Kyiv
    expect(isQuietHourLocal(new Date("2026-06-10T21:00:00Z"), KYIV)).toBe(true); // 00:00 Kyiv
  });
});

describe("isRushMode / batchSizeFor", () => {
  it("is rush when the drop is within 48h", () => {
    const now = new Date("2026-06-10T00:00:00Z");
    expect(isRushMode(now, new Date("2026-06-11T00:00:00Z"))).toBe(true); // 24h
    expect(isRushMode(now, new Date("2026-06-13T00:00:00Z"))).toBe(false); // 72h
    expect(isRushMode(now, new Date("2026-06-09T00:00:00Z"))).toBe(false); // past
  });

  it("shrinks the batch in rush mode", () => {
    expect(batchSizeFor(false)).toBe(3);
    expect(batchSizeFor(true)).toBe(2);
  });
});

describe("selectNextProfilerQuestion", () => {
  const CYCLE = "2026-06-11";

  function row(over: Partial<ProfilerAnswerRow> & { questionId: string }): ProfilerAnswerRow {
    return {
      answerText: null,
      skipped: false,
      skipReturned: false,
      cycleId: CYCLE,
      ...over,
    };
  }

  it("asks the highest-priority never-asked question first", () => {
    expect(selectNextProfilerQuestion("female", [], CYCLE)?.id).toBe("f_date_spots");
  });

  it("skips answered questions and moves down the bank", () => {
    const q = selectNextProfilerQuestion(
      "female",
      [row({ questionId: "f_date_spots", answerText: "cafes" })],
      CYCLE,
    );
    expect(q?.id).toBe("f_comm_style");
  });

  it("prefers a never-asked question over a skipped one (return comes later)", () => {
    const q = selectNextProfilerQuestion(
      "female",
      [row({ questionId: "f_date_spots", skipped: true })],
      CYCLE,
    );
    expect(q?.id).toBe("f_comm_style");
  });

  it("re-offers a skipped question once everything else is asked", () => {
    const rows = profilerAllAsked().map((id) =>
      id === "f_turnoffs" ? row({ questionId: id, skipped: true }) : row({ questionId: id, answerText: "x" }),
    );
    expect(selectNextProfilerQuestion("female", rows, CYCLE)?.id).toBe("f_turnoffs");
  });

  it("suppresses a question already skip-returned in the current cycle", () => {
    const rows = profilerAllAsked().map((id) =>
      id === "f_turnoffs"
        ? row({ questionId: id, skipped: true, skipReturned: true })
        : row({ questionId: id, answerText: "x" }),
    );
    expect(selectNextProfilerQuestion("female", rows, CYCLE)).toBeNull();
  });

  it("re-eligible when the skip-suppression was in a PREVIOUS cycle", () => {
    const rows = profilerAllAsked().map((id) =>
      id === "f_turnoffs"
        ? row({ questionId: id, skipped: true, skipReturned: true, cycleId: "2026-06-04" })
        : row({ questionId: id, answerText: "x" }),
    );
    expect(selectNextProfilerQuestion("female", rows, CYCLE)?.id).toBe("f_turnoffs");
  });

  it("returns null when every question is answered", () => {
    const rows = profilerAllAsked().map((id) => row({ questionId: id, answerText: "x" }));
    expect(selectNextProfilerQuestion("female", rows, CYCLE)).toBeNull();
  });

  it("re-asks a situational question answered in an EARLIER cycle", () => {
    // Everything answered, but the refreshables were answered last week — those
    // are exactly the questions worth asking again ("what are you watching").
    const rows = profilerAllAsked().map((id) =>
      row({ questionId: id, answerText: "x", cycleId: "2026-06-04" }),
    );
    const next = selectNextProfilerQuestion("female", rows, CYCLE);
    expect(next?.refresh).toBe("cycle");
    expect(next?.id).toBe("f_weekend_plans");
  });

  it("does not re-ask a situational question already refreshed this cycle", () => {
    const refreshable = profilerQuestionBank("female").filter((q) => q.refresh === "cycle");
    expect(refreshable.length).toBeGreaterThan(0);
    const rows = profilerAllAsked().map((id) =>
      row({
        questionId: id,
        answerText: "x",
        cycleId: refreshable.some((q) => q.id === id) ? CYCLE : "2026-06-04",
      }),
    );
    expect(selectNextProfilerQuestion("female", rows, CYCLE)).toBeNull();
  });

  it("prefers a never-asked question over a stale situational one", () => {
    const rows = [row({ questionId: "f_media", answerText: "a book", cycleId: "2026-06-04" })];
    expect(selectNextProfilerQuestion("female", rows, CYCLE)?.id).toBe("f_date_spots");
  });
});

describe("shouldCaptureProfilerAnswer", () => {
  const NOW = new Date("2026-06-10T12:00:00Z");
  const OPEN = new Date("2026-06-10T12:30:00Z");
  const CLOSED = new Date("2026-06-10T11:30:00Z");

  it("captures plain text while the implicit window is open", () => {
    const state = {
      activeQuestionId: "f_media",
      answerWindowUntil: OPEN,
      questionMessageId: 42,
    };
    expect(shouldCaptureProfilerAnswer(state, { now: NOW })).toBe(true);
  });

  it("still captures past the window while nothing else has happened", () => {
    // Past the 90-minute window but with the window still non-null: the user
    // has done nothing since the question, it is on screen, its Skip works —
    // so this is a late answer, not a new topic.
    const state = {
      activeQuestionId: "f_media",
      answerWindowUntil: CLOSED,
      questionMessageId: 42,
    };
    expect(shouldCaptureProfilerAnswer(state, { now: NOW })).toBe(true);
  });

  it("does NOT capture a question-shaped message past the window", () => {
    // The case the window was protecting: "when is my date?" typed hours later
    // belongs to the assistant.
    const state = {
      activeQuestionId: "f_media",
      answerWindowUntil: CLOSED,
      questionMessageId: 42,
    };
    expect(
      shouldCaptureProfilerAnswer(state, { now: NOW, looksLikeQuestion: true }),
    ).toBe(false);
  });

  it("captures a question-shaped message INSIDE the window", () => {
    // Deliberately additive: a short genuine answer ending in "?" ("не знаю,
    // может кино?") must keep counting while the window is fresh.
    const state = {
      activeQuestionId: "f_media",
      answerWindowUntil: OPEN,
      questionMessageId: 42,
    };
    expect(
      shouldCaptureProfilerAnswer(state, { now: NOW, looksLikeQuestion: true }),
    ).toBe(true);
  });

  it("does NOT capture after the window was closed by another interaction", () => {
    const state = {
      activeQuestionId: "f_media",
      answerWindowUntil: null,
      questionMessageId: 42,
    };
    expect(shouldCaptureProfilerAnswer(state, { now: NOW })).toBe(false);
  });

  it("captures an explicit reply to the question however late it is", () => {
    const state = {
      activeQuestionId: "f_media",
      answerWindowUntil: null,
      questionMessageId: 42,
    };
    expect(shouldCaptureProfilerAnswer(state, { now: NOW, replyToMessageId: 42 })).toBe(true);
  });

  it("ignores a reply to some other message", () => {
    const state = {
      activeQuestionId: "f_media",
      answerWindowUntil: null,
      questionMessageId: 42,
    };
    expect(shouldCaptureProfilerAnswer(state, { now: NOW, replyToMessageId: 7 })).toBe(false);
  });

  it("never captures without an active question", () => {
    const state = { activeQuestionId: null, answerWindowUntil: OPEN, questionMessageId: 42 };
    expect(shouldCaptureProfilerAnswer(state, { now: NOW, replyToMessageId: 42 })).toBe(false);
  });
});

describe("skipTransition", () => {
  const CYCLE = "2026-06-11";
  it("first skip → not yet returned", () => {
    expect(skipTransition(undefined, CYCLE)).toEqual({ skipped: true, skipReturned: false });
  });
  it("re-skip in the same cycle → suppressed", () => {
    const existing = {
      questionId: "f_turnoffs",
      answerText: null,
      skipped: true,
      skipReturned: false,
      cycleId: CYCLE,
    };
    expect(skipTransition(existing, CYCLE)).toEqual({ skipped: true, skipReturned: true });
  });
  it("skip in a new cycle resets the return flag", () => {
    const existing = {
      questionId: "f_turnoffs",
      answerText: null,
      skipped: true,
      skipReturned: true,
      cycleId: "2026-06-04",
    };
    expect(skipTransition(existing, CYCLE)).toEqual({ skipped: true, skipReturned: false });
  });
});

/**
 * Every female question id, for "everything asked" setups. Derived from the
 * bank rather than hardcoded — a hardcoded list silently rots as questions are
 * added or removed, turning "all asked" into "all but the new ones", which
 * makes the skip/return assertions below pass for the wrong reason.
 */
function profilerAllAsked(): string[] {
  return profilerQuestionBank("female").map((q) => q.id);
}
