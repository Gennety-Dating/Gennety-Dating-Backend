import { describe, it, expect } from "vitest";
import { parseWeeklyCron, getNextBatchDate, formatNextBatchDate } from "./next-batch.js";

/**
 * All tests anchor on absolute UTC instants so they're TZ-independent.
 * Results are asserted against the Europe/Kyiv wall-clock projection
 * (DST: UTC+2 winter, UTC+3 summer — Apr 2025 is summer → UTC+3).
 */

function kyivParts(date: Date): { weekday: string; date: string; time: string } {
  return {
    weekday: date.toLocaleDateString("en-US", { timeZone: "Europe/Kyiv", weekday: "long" }),
    date: date.toLocaleDateString("en-US", { timeZone: "Europe/Kyiv", month: "2-digit", day: "2-digit", year: "numeric" }),
    time: date.toLocaleTimeString("en-US", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

describe("parseWeeklyCron", () => {
  it("parses the default Thursday 18:00 cron", () => {
    const parsed = parseWeeklyCron("0 18 * * 4");
    expect(parsed).toEqual({ minute: 0, hour: 18, dayOfWeek: 4 });
  });

  it("normalises day=7 to day=0 (Sunday)", () => {
    const parsed = parseWeeklyCron("30 20 * * 7");
    expect(parsed).toEqual({ minute: 30, hour: 20, dayOfWeek: 0 });
  });

  it("parses a Wednesday 9:15 cron", () => {
    const parsed = parseWeeklyCron("15 9 * * 3");
    expect(parsed).toEqual({ minute: 15, hour: 9, dayOfWeek: 3 });
  });

  it("throws on invalid expression", () => {
    expect(() => parseWeeklyCron("bad")).toThrow();
  });
});

describe("getNextBatchDate (Europe/Kyiv anchored)", () => {
  it("returns next Thursday when today is Monday", () => {
    // Monday April 14, 2025, 10:00 Kyiv → 07:00 UTC (UTC+3 DST).
    const now = new Date(Date.UTC(2025, 3, 14, 7, 0, 0));
    const next = getNextBatchDate(now, "0 18 * * 4");

    const parts = kyivParts(next);
    expect(parts.weekday).toBe("Thursday");
    expect(parts.date).toBe("04/17/2025");
    expect(parts.time).toBe("18:00");
  });

  it("returns next week when today IS Thursday but time has passed", () => {
    // Thursday April 17, 2025, 19:00 Kyiv → 16:00 UTC.
    const now = new Date(Date.UTC(2025, 3, 17, 16, 0, 0));
    const next = getNextBatchDate(now, "0 18 * * 4");

    const parts = kyivParts(next);
    expect(parts.weekday).toBe("Thursday");
    expect(parts.date).toBe("04/24/2025");
  });

  it("returns today when it is Thursday and time has NOT passed", () => {
    // Thursday April 17, 2025, 10:00 Kyiv → 07:00 UTC.
    const now = new Date(Date.UTC(2025, 3, 17, 7, 0, 0));
    const next = getNextBatchDate(now, "0 18 * * 4");

    const parts = kyivParts(next);
    expect(parts.weekday).toBe("Thursday");
    expect(parts.date).toBe("04/17/2025");
    expect(parts.time).toBe("18:00");
  });

  it("returns exactly on the minute when now is one minute before", () => {
    // Thursday April 17, 2025, 17:59 Kyiv → 14:59 UTC.
    const now = new Date(Date.UTC(2025, 3, 17, 14, 59, 0));
    const next = getNextBatchDate(now, "0 18 * * 4");

    const parts = kyivParts(next);
    expect(parts.date).toBe("04/17/2025");
    expect(parts.time).toBe("18:00");
  });

  it("skips to next week when now is exactly on the cron time", () => {
    // Thursday April 17, 2025, 18:00:00 Kyiv → 15:00 UTC.
    const now = new Date(Date.UTC(2025, 3, 17, 15, 0, 0));
    const next = getNextBatchDate(now, "0 18 * * 4");

    const parts = kyivParts(next);
    expect(parts.date).toBe("04/24/2025");
  });

  it("works with a non-Thursday cron (Wednesday 9:00)", () => {
    // Monday April 14, 2025, 10:00 Kyiv → 07:00 UTC.
    const now = new Date(Date.UTC(2025, 3, 14, 7, 0, 0));
    const next = getNextBatchDate(now, "0 9 * * 3");

    const parts = kyivParts(next);
    expect(parts.weekday).toBe("Wednesday");
    expect(parts.date).toBe("04/16/2025");
    expect(parts.time).toBe("09:00");
  });

  it("handles winter DST (UTC+2) correctly", () => {
    // Monday January 6, 2025, 10:00 Kyiv → 08:00 UTC (UTC+2 standard).
    const now = new Date(Date.UTC(2025, 0, 6, 8, 0, 0));
    const next = getNextBatchDate(now, "0 18 * * 4");

    const parts = kyivParts(next);
    expect(parts.weekday).toBe("Thursday");
    expect(parts.date).toBe("01/09/2025");
    expect(parts.time).toBe("18:00");
    // 18:00 Kyiv on Jan 9 = 16:00 UTC in winter.
    expect(next.getUTCHours()).toBe(16);
  });
});

describe("formatNextBatchDate", () => {
  it("returns a human-readable date string in Kyiv time", () => {
    // Monday April 14, 2025, 10:00 Kyiv.
    const now = new Date(Date.UTC(2025, 3, 14, 7, 0, 0));
    const formatted = formatNextBatchDate(now, "0 18 * * 4", "en-US");

    expect(formatted).toContain("Thursday");
    expect(formatted).toContain("April");
    expect(formatted).toContain("17");
    expect(formatted).toContain("18:00");
  });
});
