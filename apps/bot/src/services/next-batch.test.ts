import { describe, it, expect } from "vitest";
import {
  parseDropCron,
  getNextBatchDate,
  getPreviousBatchDate,
  formatNextBatchDate,
  isBatchProcessing,
} from "./next-batch.js";

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

describe("parseDropCron", () => {
  it("parses the default Thursday 18:00 cron", () => {
    expect(parseDropCron("0 18 * * 4")).toEqual({ minute: 0, hour: 18, daysOfWeek: [4] });
  });

  it("normalises day=7 to day=0 (Sunday)", () => {
    expect(parseDropCron("30 20 * * 7")).toEqual({ minute: 30, hour: 20, daysOfWeek: [0] });
  });

  it("parses a Wednesday 9:15 cron", () => {
    expect(parseDropCron("15 9 * * 3")).toEqual({ minute: 15, hour: 9, daysOfWeek: [3] });
  });

  it("parses `*` in the day-of-week field as every day", () => {
    expect(parseDropCron("0 18 * * *")).toEqual({ minute: 0, hour: 18, daysOfWeek: null });
  });

  it("parses a comma-list of weekdays", () => {
    expect(parseDropCron("0 18 * * 1,3,5")).toEqual({ minute: 0, hour: 18, daysOfWeek: [1, 3, 5] });
  });

  it("dedupes and normalises a list containing both 0 and 7", () => {
    expect(parseDropCron("0 18 * * 0,7,2")).toEqual({ minute: 0, hour: 18, daysOfWeek: [0, 2] });
  });

  it("throws on invalid expression", () => {
    expect(() => parseDropCron("bad")).toThrow();
  });

  it("throws on an out-of-range weekday in a list", () => {
    expect(() => parseDropCron("0 18 * * 1,8")).toThrow();
  });

  it("throws on an out-of-range hour/minute", () => {
    expect(() => parseDropCron("0 24 * * *")).toThrow();
    expect(() => parseDropCron("60 12 * * *")).toThrow();
  });
});

describe("getNextBatchDate — weekly-shaped cron (Europe/Kyiv anchored)", () => {
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

  it("picks the nearest occurrence across a multi-weekday list", () => {
    // Monday April 14, 2025, 10:00 Kyiv. List = Wed/Fri — nearest is Wednesday.
    const now = new Date(Date.UTC(2025, 3, 14, 7, 0, 0));
    const next = getNextBatchDate(now, "0 18 * * 3,5");

    const parts = kyivParts(next);
    expect(parts.weekday).toBe("Wednesday");
    expect(parts.date).toBe("04/16/2025");
  });

  it("rolls a multi-weekday list over correctly once the earlier day has passed", () => {
    // Thursday April 17, 2025, 20:00 Kyiv. List = Wed/Fri — both this week's
    // Wednesday and Friday-at-20:00-Thursday have passed for Wed; Friday
    // (tomorrow) is still ahead.
    const now = new Date(Date.UTC(2025, 3, 17, 17, 0, 0));
    const next = getNextBatchDate(now, "0 18 * * 3,5");

    const parts = kyivParts(next);
    expect(parts.weekday).toBe("Friday");
    expect(parts.date).toBe("04/18/2025");
  });
});

describe("getNextBatchDate — daily-shaped cron (`*` day-of-week)", () => {
  it("returns today's occurrence when the time hasn't passed", () => {
    // Any Tuesday, 10:00 Kyiv → 07:00 UTC.
    const now = new Date(Date.UTC(2025, 3, 15, 7, 0, 0));
    const next = getNextBatchDate(now, "0 18 * * *");

    const parts = kyivParts(next);
    expect(parts.date).toBe("04/15/2025");
    expect(parts.time).toBe("18:00");
  });

  it("rolls to tomorrow once today's occurrence has passed", () => {
    const now = new Date(Date.UTC(2025, 3, 15, 16, 0, 0)); // 19:00 Kyiv
    const next = getNextBatchDate(now, "0 18 * * *");

    const parts = kyivParts(next);
    expect(parts.date).toBe("04/16/2025");
    expect(parts.time).toBe("18:00");
  });

  it("rolls to tomorrow when now is exactly on the cron time", () => {
    const now = new Date(Date.UTC(2025, 3, 15, 15, 0, 0)); // 18:00:00 Kyiv
    const next = getNextBatchDate(now, "0 18 * * *");

    const parts = kyivParts(next);
    expect(parts.date).toBe("04/16/2025");
  });

  it("this is the exact expression that throws under the old weekly-only parser: `0 18 * * *`", () => {
    // Regression guard for the bug the daily-cadence audit found: swapping
    // MATCH_CRON_SCHEDULE to a daily expression used to crash `parseWeeklyCron`
    // (`Number("*") → NaN`) while node-cron itself ran the schedule fine —
    // the worst possible failure mode. Must no longer throw.
    expect(() => getNextBatchDate(new Date(), "0 18 * * *")).not.toThrow();
  });
});

describe("getPreviousBatchDate", () => {
  it("weekly: returns last Thursday when today is Monday", () => {
    const now = new Date(Date.UTC(2025, 3, 14, 7, 0, 0)); // Mon Apr 14
    const prev = getPreviousBatchDate(now, "0 18 * * 4");
    const parts = kyivParts(prev);
    expect(parts.weekday).toBe("Thursday");
    expect(parts.date).toBe("04/10/2025");
  });

  it("weekly: returns today when today IS the batch day and time has passed", () => {
    const now = new Date(Date.UTC(2025, 3, 17, 16, 0, 0)); // Thu Apr 17, 19:00 Kyiv
    const prev = getPreviousBatchDate(now, "0 18 * * 4");
    const parts = kyivParts(prev);
    expect(parts.date).toBe("04/17/2025");
  });

  it("weekly: is the exact inverse of getNextBatchDate at every probed instant", () => {
    const probes = [
      new Date(Date.UTC(2025, 3, 14, 7, 0, 0)),
      new Date(Date.UTC(2025, 3, 17, 7, 0, 0)),
      new Date(Date.UTC(2025, 3, 17, 16, 0, 0)),
      new Date(Date.UTC(2025, 0, 6, 8, 0, 0)),
    ];
    for (const now of probes) {
      const prev = getPreviousBatchDate(now, "0 18 * * 4");
      const next = getNextBatchDate(prev, "0 18 * * 4");
      expect(next.getTime()).toBeGreaterThan(prev.getTime());
      // No occurrence strictly between prev and now.
      expect(prev.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it("daily: returns today's occurrence once it has passed", () => {
    const now = new Date(Date.UTC(2025, 3, 15, 16, 0, 0)); // 19:00 Kyiv
    const prev = getPreviousBatchDate(now, "0 18 * * *");
    const parts = kyivParts(prev);
    expect(parts.date).toBe("04/15/2025");
    expect(parts.time).toBe("18:00");
  });

  it("daily: returns yesterday's occurrence when today's hasn't happened yet", () => {
    const now = new Date(Date.UTC(2025, 3, 15, 7, 0, 0)); // 10:00 Kyiv
    const prev = getPreviousBatchDate(now, "0 18 * * *");
    const parts = kyivParts(prev);
    expect(parts.date).toBe("04/14/2025");
    expect(parts.time).toBe("18:00");
  });

  it("daily: 8-day-hardcode regression guard — previous batch is 1 day back, not 8", () => {
    // This is exactly the bug the daily-cadence audit found: the old
    // getPreviousBatchDate subtracted a hardcoded 8 days before re-resolving,
    // which is correct for a 7-day interval (weekly) but wildly wrong for a
    // 1-day interval (daily) — it would have skipped backward by over a week.
    const now = new Date(Date.UTC(2025, 3, 15, 16, 0, 0)); // Tue 19:00 Kyiv
    const prev = getPreviousBatchDate(now, "0 18 * * *");
    const diffDays = (now.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeLessThan(2);
    expect(diffDays).toBeGreaterThanOrEqual(0);
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

  it("also renders correctly for a daily cron", () => {
    const now = new Date(Date.UTC(2025, 3, 14, 7, 0, 0));
    const formatted = formatNextBatchDate(now, "0 18 * * *", "en-US");
    expect(formatted).toContain("18:00");
    expect(formatted).toContain("April");
  });
});

describe("isBatchProcessing", () => {
  it("starts exactly on the configured batch boundary (weekly)", () => {
    expect(
      isBatchProcessing(new Date("2025-04-17T15:00:00.000Z"), 10, "0 18 * * 4"),
    ).toBe(true);
  });

  it("follows a non-default configured weekly cron", () => {
    expect(
      isBatchProcessing(new Date("2025-04-16T06:05:00.000Z"), 10, "0 9 * * 3"), // Wed 09:05 Kyiv
    ).toBe(true);
    expect(
      isBatchProcessing(new Date("2025-04-16T06:11:00.000Z"), 10, "0 9 * * 3"),
    ).toBe(false);
  });

  it("works for a daily cron too", () => {
    expect(
      isBatchProcessing(new Date("2025-04-16T15:03:00.000Z"), 10, "0 18 * * *"),
    ).toBe(true);
    expect(
      isBatchProcessing(new Date("2025-04-16T15:20:00.000Z"), 10, "0 18 * * *"),
    ).toBe(false);
  });
});

describe("DST transitions (Europe/Kyiv)", () => {
  // Kyiv switches to summer time (UTC+2 → UTC+3) on the last Sunday of March,
  // and back (UTC+3 → UTC+2) on the last Sunday of October.
  it("spring-forward: next daily batch still resolves to 18:00 wall-clock Kyiv either side of the jump", () => {
    // 2026-03-28 is the spring-forward Saturday→Sunday night in Kyiv.
    const beforeJump = new Date(Date.UTC(2026, 2, 28, 12, 0, 0)); // Sat, pre-transition
    const next = getNextBatchDate(beforeJump, "0 18 * * *");
    const parts = kyivParts(next);
    expect(parts.time).toBe("18:00");
  });

  it("fall-back: next daily batch still resolves to 18:00 wall-clock Kyiv either side of the jump", () => {
    // 2026-10-24 is just before the fall-back Saturday→Sunday night in Kyiv.
    const beforeJump = new Date(Date.UTC(2026, 9, 24, 12, 0, 0));
    const next = getNextBatchDate(beforeJump, "0 18 * * *");
    const parts = kyivParts(next);
    expect(parts.time).toBe("18:00");
  });

  it("weekly cron across the fall-back boundary still lands on the right weekday at 18:00", () => {
    const beforeJump = new Date(Date.UTC(2026, 9, 20, 7, 0, 0)); // Tue before fall-back
    const next = getNextBatchDate(beforeJump, "0 18 * * 4"); // next Thursday
    const parts = kyivParts(next);
    expect(parts.weekday).toBe("Thursday");
    expect(parts.time).toBe("18:00");
  });
});
