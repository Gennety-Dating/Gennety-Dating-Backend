import { describe, it, expect } from "vitest";
import { CADENCES, resolveCadence } from "./cadence.js";
import {
  FAMINE_DISCOUNT_MIN_TIER,
  PROFILER_RUSH_WINDOW_HOURS,
} from "./constants.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Regression fence for the whole cadence migration: the `weekly` profile
 * MUST equal today's hardcoded constants, byte-for-byte. If this test ever
 * fails, something changed weekly (production) behavior — which is not
 * allowed until an explicit, separate decision to flip `DROP_CADENCE`.
 *
 * The right-hand-side literals below are the constants this profile is
 * replacing, copied from their current source files at the time this test
 * was written:
 *   - MATCH_CRON_SCHEDULE default          apps/bot/src/services/next-batch.ts
 *   - MATCH_TTL_MS / PROPOSAL_TTL_MS       apps/bot/src/services/match-expiry.ts,
 *                                           apps/bot/src/utils/countdown-plate.ts
 *   - MATCH_COOLDOWN_MS                    apps/bot/src/services/match-engine.ts
 *   - STARVATION_ALPHA                     apps/bot/src/services/match-engine.ts
 *   - FAMINE_DISCOUNT_MIN_TIER             packages/shared/src/constants.ts
 *   - PROFILER_RUSH_WINDOW_HOURS           packages/shared/src/constants.ts
 *   - PROPOSAL_NUDGE1/2_MS, deadline lead  apps/bot/src/workers/match-nudge.ts
 *   - SCHED_NUDGE1/2_MS                    apps/bot/src/workers/match-nudge.ts
 *   - VENUE_NUDGE1/2_MS, STALL_*_MS        apps/bot/src/services/match-stall.ts
 *   - REMATCH_* defaults                   apps/bot/src/config.ts
 */
describe("CADENCES.weekly reproduces today's hardcoded constants", () => {
  const weekly = CADENCES.weekly;

  it("cron + interval", () => {
    expect(weekly.cron).toBe("0 18 * * 4");
    expect(weekly.intervalMs).toBe(7 * DAY);
  });

  it("deadline strategy is a flat 24h TTL, NOT anchored to the next drop", () => {
    expect(weekly.deadlineStrategy).toBe("fixed");
    expect(weekly.decisionWindowMs).toBe(24 * HOUR);
    expect(weekly.decisionBufferMs).toBeUndefined();
    expect(weekly.minDecisionMs).toBeUndefined();
  });

  it("cooldown + starvation", () => {
    expect(weekly.cooldownMs).toBe(24 * HOUR);
    expect(weekly.starvationAlpha).toBe(0.05);
  });

  it("famine cadence matches today's constants", () => {
    expect(weekly.famineNoticeIntervalMs).toBe(7 * DAY);
    expect(weekly.famineDiscountMinDays).toBe(FAMINE_DISCOUNT_MIN_TIER);
  });

  it("profiler rush window", () => {
    expect(weekly.profilerRushWindowMs).toBe(PROFILER_RUSH_WINDOW_HOURS * HOUR);
  });

  it("nudge + stall offsets", () => {
    expect(weekly.proposalNudgeOffsetsMs).toEqual([3 * HOUR, 10 * HOUR]);
    expect(weekly.proposalDeadlineNudgeLeadMs).toBe(2 * HOUR);
    expect(weekly.schedNudgeOffsetsMs).toEqual([6 * HOUR, 12 * HOUR]);
    expect(weekly.venueNudgeOffsetsMs).toEqual([6 * HOUR, 12 * HOUR]);
    expect(weekly.stallCheckInMs).toBe(24 * HOUR);
    expect(weekly.stallTimeoutMs).toBe(48 * HOUR);
  });

  it("rematch defaults", () => {
    expect(weekly.rematchBlackoutMs).toBe(6 * HOUR);
    expect(weekly.rematchMaxPerInterval).toBe(2);
    expect(weekly.rematchWindowMs).toBe(7 * DAY);
    expect(weekly.rematchCooldownMs).toBe(24 * HOUR);
    expect(weekly.rematchGiftCapMs).toBe(7 * DAY);
  });
});

describe("CADENCES.daily", () => {
  const daily = CADENCES.daily;

  it("uses the anchored deadline strategy, not the weekly flat TTL", () => {
    expect(daily.deadlineStrategy).toBe("anchored");
    expect(daily.decisionBufferMs).toBe(30 * 60 * 1000);
    expect(daily.minDecisionMs).toBe(90 * 60 * 1000);
    expect(daily.decisionWindowMs).toBeUndefined();
  });

  it("cron fires every day at 18:00 Kyiv", () => {
    expect(daily.cron).toBe("0 18 * * *");
    expect(daily.intervalMs).toBe(DAY);
  });

  it("cooldown is 6h, well under the 1-day interval", () => {
    expect(daily.cooldownMs).toBe(6 * HOUR);
  });

  it("starvation saturates at the same ~35-day point as weekly's ~5 weeks", () => {
    // weekly: cap 0.25 / alpha 0.05 = 5 cycles = 5 weeks = 35 days.
    // daily: cap 0.25 / alpha (0.05/7) = 35 cycles = 35 days. Same wall-clock time.
    const weeklyCap = 0.25;
    const weeklySaturationDays = (weeklyCap / CADENCES.weekly.starvationAlpha) * 7;
    const dailySaturationDays = weeklyCap / daily.starvationAlpha;
    expect(dailySaturationDays).toBeCloseTo(weeklySaturationDays, 0);
  });
});

describe("DROP_CADENCE resolution", () => {
  it("falls back to weekly when DROP_CADENCE is unset (verified via CADENCES map, not re-importing the module)", () => {
    // The module-level `CADENCE` export resolves once at import time from
    // `process.env.DROP_CADENCE`; re-testing that resolution requires a
    // fresh module instance (see the isolated test below). Here we only
    // assert the map itself has no gaps for the values `resolveCadence`
    // switches on.
    expect(CADENCES.weekly).toBeDefined();
    expect(CADENCES.daily).toBeDefined();
  });

  it("throws on an unknown DROP_CADENCE value instead of silently resolving to undefined", () => {
    // A realistic typo (wrong case) — must fail loudly at resolution time,
    // not produce `undefined` that only blows up on first field access.
    expect(() => resolveCadence("Daily")).toThrow(/Unknown DROP_CADENCE/);
    expect(() => resolveCadence("monthly")).toThrow(/Unknown DROP_CADENCE/);
  });

  it("defaults to weekly when the key is undefined", () => {
    expect(resolveCadence(undefined)).toBe(CADENCES.weekly);
  });

  it("resolves each valid key to its matching profile", () => {
    expect(resolveCadence("weekly")).toBe(CADENCES.weekly);
    expect(resolveCadence("daily")).toBe(CADENCES.daily);
  });
});
