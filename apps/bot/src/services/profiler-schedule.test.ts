import { describe, it, expect } from "vitest";
import {
  PROFILER_ANSWER_WINDOW_MS,
  PROFILER_CONTEXT_WEEKLY_CAP,
  PROFILER_FOLLOWUP_AFTER_MS,
  PROFILER_FORMAT_COOLDOWN_MS,
  PROFILER_FORMAT_MAX_AGE_MS,
  PROFILER_FORMAT_MIN_AGE_MS,
  PROFILER_RECHECK_AFTER_MS,
  PROFILER_STALL_TIMEOUT_MS,
  PROFILER_TOPIC_MAX_LEAD_MS,
  PROFILER_TOPIC_MIN_LEAD_MS,
  contextualProfilerQuestion,
  profilerQuestionBank,
} from "@gennety/shared";
import {
  batchSizeFor,
  isQuietHourLocal,
  isRushMode,
  nextProfilerBatchStep,
  nextWindowAt,
  profilerActiveQuestionPatch,
  resolveZone,
  selectContextualProfilerQuestion,
  selectNextProfilerQuestion,
  shouldCaptureProfilerAnswer,
  skipTransition,
  type ProfilerAnswerRow,
  type ProfilerContextSignals,
} from "./profiler-schedule.js";

const KYIV = "Europe/Kyiv";
const MATCH_ID = "3f2b8c4e-9a1d-4e5f-8b7c-6d5e4f3a2b1c";

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
      answeredAt: null,
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

  it("never re-asks an answer from an earlier cycle — the weekly re-asks were cut", () => {
    const rows = profilerAllAsked().map((id) =>
      row({ questionId: id, answerText: "x", cycleId: "2026-06-04" }),
    );
    expect(selectNextProfilerQuestion("female", rows, CYCLE)).toBeNull();
  });

  it("opens with the contextual question when the caller found one", () => {
    const contextual = contextualProfilerQuestion("female", "topic", MATCH_ID)!;
    expect(selectNextProfilerQuestion("female", [], CYCLE, contextual)?.id).toBe(contextual.id);
  });

  it("never brings a skipped contextual question back", () => {
    const rows = [
      ...profilerAllAsked().map((id) => row({ questionId: id, answerText: "x" })),
      row({ questionId: `f_ctx:topic:${MATCH_ID}`, skipped: true, cycleId: "2026-06-04" }),
    ];
    expect(selectNextProfilerQuestion("female", rows, CYCLE)).toBeNull();
  });
});

describe("selectContextualProfilerQuestion", () => {
  const NOW = new Date("2026-10-04T10:00:00Z");
  const CYCLE = "2026-W40";
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const NONE: ProfilerContextSignals = {
    upcomingDates: [],
    attendedDates: [],
    signatureExperience: null,
  };

  function row(over: Partial<ProfilerAnswerRow> & { questionId: string }): ProfilerAnswerRow {
    return {
      answerText: null,
      answeredAt: null,
      skipped: false,
      skipReturned: false,
      cycleId: "2026-W30",
      ...over,
    };
  }
  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
  const pick = (rows: ProfilerAnswerRow[], signals: Partial<ProfilerContextSignals> = {}) =>
    selectContextualProfilerQuestion("female", rows, { ...NONE, ...signals }, NOW, CYCLE)?.id ??
    null;

  it("asks nothing when nothing happened", () => {
    expect(pick([])).toBeNull();
    expect(selectContextualProfilerQuestion(null, [], NONE, NOW, CYCLE)).toBeNull();
  });

  it("topic: only while the answer can still reach the T-5h icebreakers, and not days early", () => {
    const date = (lead: number) => ({ upcomingDates: [{ matchId: MATCH_ID, at: at(lead) }] });
    expect(pick([], date(24 * HOUR))).toBe(`f_ctx:topic:${MATCH_ID}`);
    expect(pick([], date(PROFILER_TOPIC_MIN_LEAD_MS - 1))).toBeNull();
    expect(pick([], date(PROFILER_TOPIC_MAX_LEAD_MS + 1))).toBeNull();
  });

  it("topic: once per date — any row means asked", () => {
    const rows = [row({ questionId: `f_ctx:topic:${MATCH_ID}`, skipped: true })];
    expect(pick(rows, { upcomingDates: [{ matchId: MATCH_ID, at: at(24 * HOUR) }] })).toBeNull();
  });

  it("format: two days to three weeks after a confirmed date", () => {
    const date = (age: number) => ({ attendedDates: [{ matchId: MATCH_ID, at: at(-age) }] });
    expect(pick([], date(3 * DAY))).toBe(`f_ctx:format:${MATCH_ID}`);
    expect(pick([], date(PROFILER_FORMAT_MIN_AGE_MS - 1))).toBeNull();
    expect(pick([], date(PROFILER_FORMAT_MAX_AGE_MS + 1))).toBeNull();
  });

  it("format: one per cooldown however many dates happened", () => {
    const rows = [
      row({ questionId: "f_ctx:format:older-match", answerText: "same", answeredAt: at(-5 * DAY) }),
    ];
    expect(pick(rows, { attendedDates: [{ matchId: MATCH_ID, at: at(-3 * DAY) }] })).toBeNull();
    const cooled = [
      row({
        questionId: "f_ctx:format:older-match",
        answerText: "same",
        answeredAt: at(-PROFILER_FORMAT_COOLDOWN_MS - 1),
      }),
    ];
    expect(pick(cooled, { attendedDates: [{ matchId: MATCH_ID, at: at(-3 * DAY) }] })).toBe(
      `f_ctx:format:${MATCH_ID}`,
    );
  });

  it("signature: the leading experience, once", () => {
    expect(pick([], { signatureExperience: "coffee_treats" })).toBe("f_ctx:signature:coffee_treats");
    const asked = [row({ questionId: "f_ctx:signature:coffee_treats", answerText: "yes" })];
    expect(pick(asked, { signatureExperience: "coffee_treats" })).toBeNull();
  });

  it("followup: a month after the person's own plan, never for a skip", () => {
    const learned = (age: number) => [
      row({ questionId: "f_learning", answerText: "guitar", answeredAt: at(-age) }),
    ];
    expect(pick(learned(PROFILER_FOLLOWUP_AFTER_MS + DAY))).toBe("f_ctx:followup:f_learning");
    expect(pick(learned(PROFILER_FOLLOWUP_AFTER_MS - DAY))).toBeNull();
    expect(pick([row({ questionId: "f_learning", skipped: true })])).toBeNull();
  });

  it("recheck: two months after a matching-candidate answer", () => {
    const rows = [
      row({ questionId: "f_chronotype", answerText: "owl", answeredAt: at(-PROFILER_RECHECK_AFTER_MS - DAY) }),
    ];
    expect(pick(rows)).toBe("f_ctx:recheck:f_chronotype");
  });

  it("orders by how perishable the moment is: topic first", () => {
    const rows = [
      row({ questionId: "f_learning", answerText: "guitar", answeredAt: at(-40 * DAY) }),
    ];
    expect(
      pick(rows, {
        upcomingDates: [{ matchId: MATCH_ID, at: at(24 * HOUR) }],
        signatureExperience: "walk_view",
      }),
    ).toBe(`f_ctx:topic:${MATCH_ID}`);
  });

  it("asks at most the weekly cap of contextual questions", () => {
    const thisWeek = Array.from({ length: PROFILER_CONTEXT_WEEKLY_CAP }, (_, i) =>
      row({ questionId: `f_ctx:topic:match-${i}`, skipped: true, cycleId: CYCLE }),
    );
    expect(pick(thisWeek, { signatureExperience: "walk_view" })).toBeNull();
    const lastWeek = thisWeek.map((r) => ({ ...r, cycleId: "2026-W39" }));
    expect(pick(lastWeek, { signatureExperience: "walk_view" })).toBe("f_ctx:signature:walk_view");
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

describe("nextProfilerBatchStep", () => {
  const CYCLE = "2026-W24";
  const answeredRow = (questionId: string): ProfilerAnswerRow => ({
    questionId,
    answerText: "x",
    answeredAt: null,
    skipped: false,
    skipReturned: false,
    cycleId: CYCLE,
  });

  it("asks the next pending question while the batch has room", () => {
    const step = nextProfilerBatchStep("female", [answeredRow("f_date_spots")], 2, CYCLE);
    expect(step).toEqual({ kind: "ask", question: expect.objectContaining({ id: "f_comm_style" }) });
  });

  it("pauses at the batch boundary when the batch is spent but questions remain", () => {
    expect(nextProfilerBatchStep("female", [], 0, CYCLE)).toEqual({ kind: "boundary" });
  });

  it("reports exhaustion before the counter — nothing pending finishes even mid-batch", () => {
    const all = profilerAllAsked().map(answeredRow);
    expect(nextProfilerBatchStep("female", all, 2, CYCLE)).toEqual({ kind: "exhausted" });
    expect(nextProfilerBatchStep("female", all, 0, CYCLE)).toEqual({ kind: "exhausted" });
  });

  it("is exhausted for an unknown gender (empty bank)", () => {
    expect(nextProfilerBatchStep(null, [], 3, CYCLE)).toEqual({ kind: "exhausted" });
  });
});

describe("profilerActiveQuestionPatch", () => {
  const NOW = new Date("2026-06-10T07:00:00Z");

  it("a Telegram-delivered question anchors its message and opens the free-text window", () => {
    expect(profilerActiveQuestionPatch("f_humor", 1, NOW, 42)).toEqual({
      profilerActiveQuestionId: "f_humor",
      profilerBatchRemaining: 1,
      profilerAnswerWindowUntil: new Date(NOW.getTime() + PROFILER_ANSWER_WINDOW_MS),
      profilerQuestionMessageId: 42,
      profilerNextAt: new Date(NOW.getTime() + PROFILER_STALL_TIMEOUT_MS),
    });
  });

  it("an app-delivered question opens no window, so Telegram text is never captured for it", () => {
    expect(profilerActiveQuestionPatch("f_humor", 2, NOW, null)).toEqual({
      profilerActiveQuestionId: "f_humor",
      profilerBatchRemaining: 2,
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
      // Still a stall deadline, never null: the worker's reclaim sweep keys on it.
      profilerNextAt: new Date(NOW.getTime() + PROFILER_STALL_TIMEOUT_MS),
    });
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
