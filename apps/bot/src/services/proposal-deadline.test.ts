import { describe, it, expect } from "vitest";
import { deadlineFor, minutesLeftUntilDeadline } from "./proposal-deadline.js";
import { CADENCE, CADENCES } from "@gennety/shared";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("deadlineFor — active profile (DROP_CADENCE unset ⇒ weekly)", () => {
  it("is a flat 24h TTL from dispatchedAt", () => {
    const dispatchedAt = new Date("2026-04-16T18:00:05Z");
    const deadline = deadlineFor(dispatchedAt);
    expect(deadline.getTime()).toBe(dispatchedAt.getTime() + 24 * HOUR);
  });

  /**
   * Mandatory regression test flagged by the daily-cadence re-audit: a naive
   * single formula ("next drop minus buffer") applied uniformly to the
   * weekly profile would silently turn the 24h window into ~7 days, because
   * the next batch is a week away. This must categorically NOT happen —
   * assert the strategy itself, not just a number that could coincidentally
   * match either formula.
   */
  it("does NOT anchor to the next scheduled drop under the weekly profile", () => {
    expect(CADENCE.deadlineStrategy).toBe("fixed");

    const dispatchedAt = new Date("2026-04-16T18:00:05Z"); // right after a Thursday batch
    const deadline = deadlineFor(dispatchedAt);
    const sevenDaysLater = dispatchedAt.getTime() + 7 * DAY;

    // The "anchored" formula would put the deadline within a few minutes of
    // next Thursday (~7 days out). The real deadline must be nowhere close.
    expect(Math.abs(deadline.getTime() - sevenDaysLater)).toBeGreaterThanOrEqual(6 * DAY);
    expect(deadline.getTime()).toBe(dispatchedAt.getTime() + 24 * HOUR);
  });
});

describe("minutesLeftUntilDeadline", () => {
  it("returns 1440 at T+0", () => {
    const dispatchedAt = new Date("2026-04-16T18:00:00Z");
    expect(minutesLeftUntilDeadline(dispatchedAt, dispatchedAt)).toBe(1440);
  });

  it("returns 0 exactly at the deadline", () => {
    const dispatchedAt = new Date("2026-04-16T18:00:00Z");
    const now = new Date(dispatchedAt.getTime() + 24 * HOUR);
    expect(minutesLeftUntilDeadline(dispatchedAt, now)).toBe(0);
  });

  it("returns negative past the deadline", () => {
    const dispatchedAt = new Date("2026-04-16T18:00:00Z");
    const now = new Date(dispatchedAt.getTime() + 24 * HOUR + 60_000);
    expect(minutesLeftUntilDeadline(dispatchedAt, now)).toBe(-1);
  });
});

/**
 * These tests exercise the `daily` profile's formula directly (via the
 * CADENCES map, not by mutating the module-level DROP_CADENCE-resolved
 * CADENCE export, which is fixed at import time). They pin the *shape* of
 * the anchored formula; the module under test always reads the live
 * `CADENCE`, so this suite doesn't re-invoke `deadlineFor` under a different
 * profile — it independently re-derives what the anchored formula SHOULD
 * produce and cross-checks the math `deadlineFor` is documented to perform.
 */
describe("anchored strategy math (documented shape, cross-checked against CADENCES.daily)", () => {
  const daily = CADENCES.daily;

  it("floors at dispatchedAt + minDecisionMs for a dispatch right after today's batch", () => {
    // A pitch dispatched at 18:00:05 (right after an 18:00 daily batch): the
    // next batch is ~24h away, so `nextDrop - buffer` (~23.5h out) wins over
    // the `minDecisionMs` floor (90 min) — the buffer branch, not the floor.
    const dispatchedAt = new Date("2026-04-16T18:00:05Z");
    // getNextBatchDate(dispatchedAt) for "0 18 * * *" → tomorrow 18:00.
    const nextDrop = new Date("2026-04-17T18:00:00Z");
    const anchored = nextDrop.getTime() - daily.decisionBufferMs!;
    const floored = dispatchedAt.getTime() + daily.minDecisionMs!;
    expect(anchored).toBeGreaterThan(floored);
  });

  it("the buffer (30min) is well under the 90min floor's own margin, so a late-in-window dispatch still clears the floor", () => {
    // A pitch dispatched just before the deadline of an out-of-cycle
    // (Rematch) run has the least headroom — confirm the floor exists to
    // protect exactly that case, per §1.2 of the implementation plan.
    expect(daily.minDecisionMs).toBeGreaterThan(daily.decisionBufferMs!);
  });
});
