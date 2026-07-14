import { describe, it, expect } from "vitest";
import {
  computeStatusSnapshot,
  formatStatusText,
  formatDateCountdownText,
  nextMatchDispatchAt,
  isMatchBatchProcessing,
} from "./format-status.js";

/**
 * Fixed reference: Thursday 2026-04-16 at 18:00:00 Europe/Kyiv.
 * Kyiv in April is UTC+3 (summer time), so the UTC instant is 15:00:00Z.
 */
const NEXT_MATCH_UTC = new Date("2026-04-16T15:00:00.000Z");

function minusSeconds(anchor: Date, seconds: number): Date {
  return new Date(anchor.getTime() - seconds * 1000);
}

function minusMinutes(anchor: Date, minutes: number): Date {
  return minusSeconds(anchor, minutes * 60);
}

describe("computeStatusSnapshot", () => {
  it("returns processing when isProcessing is true", () => {
    expect(
      computeStatusSnapshot({
        now: new Date("2026-04-10T00:00:00Z"),
        nextMatchAt: NEXT_MATCH_UTC,
        isProcessing: true,
      }),
    ).toEqual({ phase: "processing" });
  });

  it("returns processing when diffMs <= 0", () => {
    expect(
      computeStatusSnapshot({ now: NEXT_MATCH_UTC, nextMatchAt: NEXT_MATCH_UTC }).phase,
    ).toBe("processing");
  });

  it("splits > 24h into days + hours-of-day", () => {
    // 3 days 2 hours out
    const snap = computeStatusSnapshot({
      now: minusMinutes(NEXT_MATCH_UTC, 3 * 24 * 60 + 2 * 60),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(snap).toEqual({ phase: "days", days: 3, hours: 2 });
  });

  it("ticks the hour field every 60 minutes during days phase", () => {
    // 3d 5h 17m rounded up = 3d 5h 17m → days/hours snapshot is (3, 5)
    const snap = computeStatusSnapshot({
      now: minusMinutes(NEXT_MATCH_UTC, 3 * 24 * 60 + 5 * 60 + 17),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(snap).toEqual({ phase: "days", days: 3, hours: 5 });
  });

  it("exactly 24h renders as 1d 0h (still days phase)", () => {
    const snap = computeStatusSnapshot({
      now: minusMinutes(NEXT_MATCH_UTC, 24 * 60),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(snap).toEqual({ phase: "days", days: 1, hours: 0 });
  });

  it("splits 1h–24h into hours + minutes-of-hour", () => {
    // 5h 45m out
    const snap = computeStatusSnapshot({
      now: minusMinutes(NEXT_MATCH_UTC, 5 * 60 + 45),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(snap).toEqual({ phase: "hours", hours: 5, minutes: 45 });
  });

  it("exactly 1h renders as 1h 0m (hours phase)", () => {
    const snap = computeStatusSnapshot({
      now: minusMinutes(NEXT_MATCH_UTC, 60),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(snap).toEqual({ phase: "hours", hours: 1, minutes: 0 });
  });

  it("< 1h renders as minutes-only", () => {
    const snap = computeStatusSnapshot({
      now: minusSeconds(NEXT_MATCH_UTC, 40 * 60 + 30),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(snap).toEqual({ phase: "minutes", minutes: 41 });
  });

  it("clamps minutes to at least 1 just before dispatch", () => {
    const snap = computeStatusSnapshot({
      now: minusSeconds(NEXT_MATCH_UTC, 0.5),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(snap).toEqual({ phase: "minutes", minutes: 1 });
  });

  it("rolls minutes-of-hour from 59 to 0 cleanly at the hour boundary", () => {
    // 2h 0m exactly → "2h 0m"
    const a = computeStatusSnapshot({
      now: minusMinutes(NEXT_MATCH_UTC, 120),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(a).toEqual({ phase: "hours", hours: 2, minutes: 0 });

    // 1h 59m → "1h 59m"
    const b = computeStatusSnapshot({
      now: minusMinutes(NEXT_MATCH_UTC, 119),
      nextMatchAt: NEXT_MATCH_UTC,
    });
    expect(b).toEqual({ phase: "hours", hours: 1, minutes: 59 });
  });
});

describe("formatStatusText", () => {
  it("renders d/h in English", () => {
    const text = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 3 * 24 * 60 + 5 * 60),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "en",
    );
    expect(text).toBe("⏳ Next match in 3d 5h");
  });

  it("renders h/m in English", () => {
    const text = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 5 * 60 + 30),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "en",
    );
    expect(text).toBe("⏳ Matches drop in 5h 30m");
  });

  it("renders minutes with the almost-ready emoji in English", () => {
    const text = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 40),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "en",
    );
    expect(text).toBe("✨ Almost ready! Matches drop in 40m");
  });

  it("renders processing", () => {
    const text = formatStatusText(
      {
        now: new Date("2026-04-10T00:00:00Z"),
        nextMatchAt: NEXT_MATCH_UTC,
        isProcessing: true,
      },
      "en",
    );
    expect(text).toBe("✨ Analyzing your city… Check back shortly.");
  });

  it("renders Russian d/h", () => {
    const text = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 3 * 24 * 60 + 2 * 60),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "ru",
    );
    expect(text).toContain("3д");
    expect(text).toContain("2ч");
  });

  it("renders Ukrainian d/h", () => {
    const text = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 3 * 24 * 60 + 2 * 60),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "uk",
    );
    expect(text).toContain("3д");
    expect(text).toContain("2г");
  });

  it("changes between consecutive minute ticks in hours phase", () => {
    const t1 = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 5 * 60 + 30),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "en",
    );
    const t2 = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 5 * 60 + 29),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "en",
    );
    expect(t1).not.toBe(t2);
  });

  it("changes between consecutive hour ticks in days phase", () => {
    const t1 = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 3 * 24 * 60 + 5 * 60),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "en",
    );
    const t2 = formatStatusText(
      {
        now: minusMinutes(NEXT_MATCH_UTC, 3 * 24 * 60 + 4 * 60),
        nextMatchAt: NEXT_MATCH_UTC,
      },
      "en",
    );
    expect(t1).not.toBe(t2);
  });
});

describe("nextMatchDispatchAt", () => {
  it("lands on Thursday 18:00 Kyiv in April (UTC+3)", () => {
    const now = new Date("2026-04-14T09:00:00Z");
    expect(nextMatchDispatchAt(now).toISOString()).toBe("2026-04-16T15:00:00.000Z");
  });

  it("lands on Thursday 18:00 Kyiv in January (UTC+2)", () => {
    const now = new Date("2026-01-13T09:00:00Z");
    expect(nextMatchDispatchAt(now).toISOString()).toBe("2026-01-15T16:00:00.000Z");
  });

  it("bumps to next week when called after Thursday 18:00 Kyiv", () => {
    const now = new Date("2026-04-16T16:00:00Z");
    expect(nextMatchDispatchAt(now).toISOString()).toBe("2026-04-23T15:00:00.000Z");
  });

  it("returns current Thursday at exactly 18:00 Kyiv", () => {
    const now = new Date("2026-04-16T15:00:00Z");
    expect(nextMatchDispatchAt(now).toISOString()).toBe("2026-04-16T15:00:00.000Z");
  });
});

describe("formatDateCountdownText", () => {
  const DATE_AT = new Date("2026-04-16T16:00:00.000Z");

  it("renders a days countdown with the venue appended", () => {
    const now = new Date("2026-04-14T16:00:00.000Z"); // exactly 2 days before
    const text = formatDateCountdownText({ now, dateAt: DATE_AT, venueName: "Blur Cafe" }, "en");
    expect(text).toContain("2d");
    expect(text).toContain("· Blur Cafe");
  });

  it("renders an hours countdown", () => {
    const now = new Date("2026-04-16T13:30:00.000Z"); // 2h30m before
    const text = formatDateCountdownText({ now, dateAt: DATE_AT, venueName: null }, "en");
    expect(text).toContain("2h");
    expect(text).not.toContain("·");
  });

  it("falls back to the 'soon' phrasing once the date moment has passed", () => {
    const now = new Date("2026-04-16T16:00:00.000Z"); // exactly at agreed time
    const text = formatDateCountdownText({ now, dateAt: DATE_AT, venueName: "Blur Cafe" }, "en");
    expect(text.toLowerCase()).toContain("today");
    expect(text).toContain("· Blur Cafe");
  });

  it("localizes the phrase (ru)", () => {
    const now = new Date("2026-04-14T16:00:00.000Z");
    const text = formatDateCountdownText({ now, dateAt: DATE_AT, venueName: null }, "ru");
    expect(text).toContain("Свидание");
  });
});

describe("isMatchBatchProcessing", () => {
  it("is true within 10 min after Thursday 18:00 Kyiv", () => {
    expect(isMatchBatchProcessing(new Date("2026-04-16T15:05:00Z"))).toBe(true);
  });

  it("is false 30 min after Thursday 18:00 Kyiv", () => {
    expect(isMatchBatchProcessing(new Date("2026-04-16T15:30:00Z"))).toBe(false);
  });

  it("is false on Wednesday", () => {
    expect(isMatchBatchProcessing(new Date("2026-04-15T15:05:00Z"))).toBe(false);
  });
});
