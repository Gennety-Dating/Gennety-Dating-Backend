import { describe, it, expect } from "vitest";
import {
  MAU_WINDOW_DAYS,
  WAU_WINDOW_DAYS,
  dailySeries,
  dayRange,
  parseDayKey,
  parseMonthKey,
  stickiness,
  summarizeActivity,
  toDayKey,
  uniqueUsers,
  windowEndingOn,
  type ActivityRow,
} from "./activity.js";

const row = (day: string, userId: string, platform = "telegram"): ActivityRow => ({
  day,
  userId,
  platform,
});

describe("day parsing", () => {
  it("rejects a date that parses but does not exist", () => {
    // `new Date("2026-02-31")` happily becomes March 3rd. A metric that
    // silently answers for a different day than the one asked for is worse
    // than a 400.
    expect(parseDayKey("2026-02-31")).toBeNull();
    expect(parseDayKey("2026-02-28")).not.toBeNull();
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    for (const bad of ["2026-2-1", "26-02-01", "2026/02/01", "", "today"]) {
      expect(parseDayKey(bad)).toBeNull();
    }
  });

  it("reads a day as UTC, not as local time", () => {
    // The whole metric is bucketed in UTC; a parser that used local time would
    // shift every bucket by the operator's offset.
    expect(parseDayKey("2026-08-27")?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("closes a calendar month without a month-length table", () => {
    expect(parseMonthKey("2026-02")).toMatchObject({
      from: new Date("2026-02-01T00:00:00.000Z"),
      to: new Date("2026-02-28T00:00:00.000Z"),
    });
    // Leap year — the one case a hardcoded table gets wrong.
    expect(parseMonthKey("2024-02")?.to).toEqual(new Date("2024-02-29T00:00:00.000Z"));
  });
});

describe("uniqueUsers", () => {
  it("counts a person once however many days they were active", () => {
    // This is the whole reason the substrate stores (day, user) pairs rather
    // than daily counters: summing DAU over a month overcounts by exactly how
    // loyal the base is.
    const rows = [
      row("2026-08-01", "u1"),
      row("2026-08-02", "u1"),
      row("2026-08-03", "u1"),
      row("2026-08-03", "u2"),
    ];
    expect(uniqueUsers(rows)).toBe(2);
  });

  it("counts a person once even when active on two platforms", () => {
    // Two rows by design (that is what makes a per-platform breakdown work),
    // but one human — MAU must not double them.
    expect(
      uniqueUsers([row("2026-08-01", "u1", "telegram"), row("2026-08-01", "u1", "ios")]),
    ).toBe(1);
  });
});

describe("dailySeries", () => {
  it("zero-fills a day with no activity instead of omitting it", () => {
    // A sparse series makes a chart draw a straight line through the gap,
    // which reads as "flat" rather than "nobody came".
    const series = dailySeries(
      [row("2026-08-01", "u1"), row("2026-08-03", "u2")],
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-03T00:00:00.000Z"),
    );
    expect(series).toEqual([
      { date: "2026-08-01", dau: 1 },
      { date: "2026-08-02", dau: 0 },
      { date: "2026-08-03", dau: 1 },
    ]);
  });

  it("deduplicates a user active many times in one day", () => {
    const series = dailySeries(
      [row("2026-08-01", "u1"), row("2026-08-01", "u1"), row("2026-08-01", "u2")],
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    expect(series).toEqual([{ date: "2026-08-01", dau: 2 }]);
  });
});

describe("windowEndingOn", () => {
  it("is inclusive on both ends", () => {
    // A 7-day WAU must span 7 days, not 8. Off by one here would inflate every
    // window number by a day's worth of users forever.
    const w = windowEndingOn(new Date("2026-08-27T00:00:00.000Z"), 7);
    expect(toDayKey(w.from)).toBe("2026-08-21");
    expect(toDayKey(w.to)).toBe("2026-08-27");
    expect(dayRange(w.from, w.to)).toHaveLength(7);
  });
});

describe("stickiness", () => {
  it("reports null on an empty base rather than a measured zero", () => {
    // "no users at all" and "users, none of them daily" are different facts.
    expect(stickiness(0, 0)).toBeNull();
    expect(stickiness(0, 10)).toBe(0);
  });

  it("is a percentage of MAU", () => {
    expect(stickiness(5, 20)).toBe(25);
  });
});

describe("summarizeActivity", () => {
  const end = new Date("2026-08-27T00:00:00.000Z");

  it("slices DAU / WAU / MAU out of one load", () => {
    const rows: ActivityRow[] = [
      row("2026-08-27", "today"),
      row("2026-08-24", "thisWeek"),
      row("2026-08-10", "thisMonth"),
      // 30-day window ending 08-27 starts 07-29, so this one is outside it.
      row("2026-07-28", "tooOld"),
    ];
    const s = summarizeActivity(rows, end);
    expect(s).toMatchObject({ date: "2026-08-27", dau: 1, wau: 2, mau: 3 });
    expect(s.windows).toEqual({ wauDays: WAU_WINDOW_DAYS, mauDays: MAU_WINDOW_DAYS });
  });

  it("includes the boundary day of the MAU window", () => {
    // 30 days ending 08-27 must include 07-29 itself, not start the day after.
    const s = summarizeActivity([row("2026-07-29", "boundary")], end);
    expect(s.mau).toBe(1);
  });

  it("breaks DAU down per platform while keeping the total deduplicated", () => {
    const s = summarizeActivity(
      [
        row("2026-08-27", "u1", "telegram"),
        row("2026-08-27", "u1", "ios"),
        row("2026-08-27", "u2", "telegram"),
      ],
      end,
    );
    expect(s.dau).toBe(2);
    expect(s.dauByPlatform).toEqual({ telegram: 2, ios: 1 });
  });
});
