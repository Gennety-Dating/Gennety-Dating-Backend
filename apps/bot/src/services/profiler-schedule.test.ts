import { describe, it, expect } from "vitest";
import {
  batchSizeFor,
  isQuietHourLocal,
  isRushMode,
  nextWindowAt,
  resolveZone,
  selectNextProfilerQuestion,
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

/** All 8 female question ids, for "everything asked" setups. */
function profilerAllAsked(): string[] {
  return [
    "f_date_spots",
    "f_comm_style",
    "f_chronotype",
    "f_sport_pref",
    "f_turnoffs",
    "f_shared_interests",
    "f_activity_pref",
    "f_media",
  ];
}
