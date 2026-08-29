import { describe, it, expect } from "vitest";
import {
  DEFAULT_MILESTONES,
  bucketRangeOf,
  computeChannelRetention,
  computeCohortRetention,
  isValidMilestone,
  lastCompleteDay,
  milestoneOffsets,
  type CohortUserInput,
} from "./cohort-retention.js";
import type { ActivityRow } from "./activity.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");

const user = (id: string, createdAt: string, referralSource: string | null = null):
  CohortUserInput => ({ id, createdAt: new Date(`${createdAt}T09:00:00.000Z`), referralSource });

const act = (userId: string, day: string): ActivityRow => ({
  day,
  userId,
  platform: "telegram",
});

/** Everything is measurable unless a test says otherwise. */
const OPTS = { now: NOW, coverageFrom: "2020-01-01" } as const;

// ---------------------------------------------------------------------------

describe("buckets", () => {
  it("anchors weeks on Monday", () => {
    // 2026-05-14 is a Thursday.
    const { start, end } = bucketRangeOf(new Date("2026-05-14T00:00:00Z"), "week");
    expect(start.toISOString().slice(0, 10)).toBe("2026-05-11");
    expect(end.toISOString().slice(0, 10)).toBe("2026-05-17");
  });

  it("ends a month on its real last day, not on 30", () => {
    const feb = bucketRangeOf(new Date("2026-02-10T00:00:00Z"), "month");
    expect(feb.end.toISOString().slice(0, 10)).toBe("2026-02-28");
  });
});

describe("milestones", () => {
  it("never lets a window reach back into day 0", () => {
    // Day 0 is the signup session. A window containing it would report
    // "came back" for someone who simply finished onboarding.
    for (const m of DEFAULT_MILESTONES) {
      expect(milestoneOffsets(m).from).toBeGreaterThanOrEqual(1);
    }
    expect(isValidMilestone({ day: 7, windowDays: 8 })).toBe(false);
    expect(isValidMilestone({ day: 0, windowDays: 1 })).toBe(false);
  });

  it("reads D30 as the trailing week 24..30", () => {
    expect(milestoneOffsets({ day: 30, windowDays: 7 })).toEqual({ from: 24, to: 30 });
  });
});

describe("the day of registration is never counted as a return", () => {
  it("scores a user who was active only on day 0 as churned", () => {
    const users = [user("u1", "2026-04-01")];
    const activity = [act("u1", "2026-04-01")];
    const m = computeCohortRetention(users, activity, {
      ...OPTS,
      bucket: "day",
      milestones: [{ day: 1, windowDays: 1 }],
    });
    expect(m.rows[0]!.cells[0]!.status).toBe("ok");
    expect(m.rows[0]!.cells[0]!.retained).toBe(0);
    expect(m.rows[0]!.cells[0]!.churnedPct).toBe(100);
  });

  it("counts a user active on day 1", () => {
    const m = computeCohortRetention(
      [user("u1", "2026-04-01")],
      [act("u1", "2026-04-02")],
      { ...OPTS, bucket: "day", milestones: [{ day: 1, windowDays: 1 }] },
    );
    expect(m.rows[0]!.cells[0]!.retainedPct).toBe(100);
  });
});

describe("window semantics", () => {
  it("counts a day inside the window and not one outside it", () => {
    const users = [user("in", "2026-04-01"), user("out", "2026-04-01")];
    const activity = [
      act("in", "2026-04-25"), // day 24 — first day of the D30 window
      act("out", "2026-04-24"), // day 23 — one day too early
    ];
    const m = computeCohortRetention(users, activity, {
      ...OPTS,
      bucket: "day",
      milestones: [{ day: 30, windowDays: 7 }],
    });
    expect(m.rows[0]!.cells[0]!.retained).toBe(1);
  });

  it("is NOT a survival curve: a later return does not backfill earlier cells", () => {
    // This is the whole difference from /admin/analytics/retention, which
    // asks whether the LAST activity is at least N units out and therefore
    // counts this user at every offset.
    const m = computeCohortRetention(
      [user("u1", "2026-04-01")],
      [act("u1", "2026-04-28")], // day 27 → inside D30's window only
      { ...OPTS, bucket: "day" },
    );
    const [d1, d7, d14, d30] = m.rows[0]!.cells;
    expect(d1!.retainedPct).toBe(0);
    expect(d7!.retainedPct).toBe(0);
    expect(d14!.retainedPct).toBe(0);
    expect(d30!.retainedPct).toBe(100);
  });
});

describe("a number is only reported when it could have been observed", () => {
  it("marks a cohort immature until its NEWEST member has had the window", () => {
    // A week cohort ending 2026-05-31 cannot report D7 on 2026-06-01: the
    // Sunday signups have had one day. Gating on the oldest member instead
    // would count them as churned for days they never had.
    const m = computeCohortRetention(
      [user("mon", "2026-05-25"), user("sun", "2026-05-31")],
      [],
      { ...OPTS, bucket: "week" },
    );
    expect(m.rows[0]!.cohortStart).toBe("2026-05-25");
    expect(m.rows[0]!.cohortEnd).toBe("2026-05-31");
    // D1 is the discriminating case: measured from the Monday it looks ready
    // (2026-05-26 is long past), and from the Sunday it plainly is not.
    expect(m.rows[0]!.cells[0]!.status).toBe("immature");
    expect(m.rows[0]!.cells[0]!.retainedPct).toBeNull();
    expect(m.rows[0]!.cells[1]!.status).toBe("immature");
  });

  it("does not report a window that ends today, because today is still filling", () => {
    // now = 2026-06-01, so the last complete day is 2026-05-31.
    expect(lastCompleteDay(NOW).toISOString().slice(0, 10)).toBe("2026-05-31");
    const m = computeCohortRetention([user("u1", "2026-05-31")], [], {
      ...OPTS,
      bucket: "day",
      milestones: [{ day: 1, windowDays: 1 }],
    });
    expect(m.rows[0]!.cells[0]!.status).toBe("immature");
  });

  it("reports no-data — never 0% — for a window the activity table predates", () => {
    // The failure this exists to prevent: instrumentation started in August,
    // so every earlier cohort would otherwise read as 100% churned and be
    // indistinguishable from a real collapse.
    const m = computeCohortRetention([user("u1", "2026-04-01")], [], {
      now: NOW,
      bucket: "day",
      coverageFrom: "2026-05-01",
    });
    for (const cell of m.rows[0]!.cells) {
      expect(cell.status).toBe("no-data");
      expect(cell.retainedPct).toBeNull();
    }
  });

  it("reports no-data for every cell when the table is empty", () => {
    const m = computeCohortRetention([user("u1", "2026-04-01")], [], {
      now: NOW,
      bucket: "day",
      coverageFrom: null,
    });
    expect(m.rows[0]!.cells.every((c) => c.status === "no-data")).toBe(true);
    expect(m.average.every((c) => c.retainedPct === null)).toBe(true);
  });
});

describe("averages", () => {
  it("weights by cohort size rather than averaging percentages", () => {
    // 1/1 and 0/9. A mean of rates says 50%; the truth is 10%.
    const users = [
      user("a", "2026-04-01"),
      ...Array.from({ length: 9 }, (_, i) => user(`b${i}`, "2026-04-02")),
    ];
    const m = computeCohortRetention(users, [act("a", "2026-04-02")], {
      ...OPTS,
      bucket: "day",
      milestones: [{ day: 1, windowDays: 1 }],
    });
    expect(m.average[0]!.retainedPct).toBe(10);
    expect(m.average[0]!.cohorts).toBe(2);
    expect(m.average[0]!.users).toBe(10);
  });

  it("excludes immature cohorts from the average instead of scoring them 0", () => {
    const users = [user("old", "2026-04-01"), user("fresh", "2026-05-31")];
    const m = computeCohortRetention(users, [act("old", "2026-04-02")], {
      ...OPTS,
      bucket: "day",
      milestones: [{ day: 1, windowDays: 1 }],
    });
    expect(m.average[0]!.retainedPct).toBe(100);
    expect(m.average[0]!.cohorts).toBe(1);
  });
});

describe("small cohorts are flagged, not hidden", () => {
  it("marks lowSample below the threshold", () => {
    const m = computeCohortRetention([user("u1", "2026-04-01")], [], {
      ...OPTS,
      bucket: "day",
    });
    expect(m.rows[0]!.lowSample).toBe(true);
    expect(m.rows[0]!.size).toBe(1);
  });
});

describe("channel slice", () => {
  const channel = (src: string | null): string => (src ? src : "organic");

  it("computes maturity per channel, not from the overall matrix", () => {
    // `ads` arrived in April and is measurable; `newads` arrived yesterday and
    // is not. Averaging the overall matrix would have reported a number for a
    // channel that has produced no observable window at all.
    const users = [
      user("a", "2026-04-01", "ads"),
      user("b", "2026-05-31", "newads"),
    ];
    const rows = computeChannelRetention(users, [act("a", "2026-04-02")], channel, {
      ...OPTS,
      bucket: "day",
      milestones: [{ day: 1, windowDays: 1 }],
    });
    const ads = rows.find((r) => r.channel === "ads")!;
    const newads = rows.find((r) => r.channel === "newads")!;
    expect(ads.cells[0]!.retainedPct).toBe(100);
    expect(newads.cells[0]!.status).toBe("immature");
    expect(newads.cells[0]!.retainedPct).toBeNull();
  });

  it("sorts by signups so the channel that matters most reads first", () => {
    const users = [
      user("a", "2026-04-01", "small"),
      user("b", "2026-04-01", "big"),
      user("c", "2026-04-01", "big"),
    ];
    const rows = computeChannelRetention(users, [], channel, { ...OPTS, bucket: "day" });
    expect(rows.map((r) => r.channel)).toEqual(["big", "small"]);
  });
});
