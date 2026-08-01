/**
 * Drop-cadence profile — the single source of truth for every timing
 * constant that depends on how often the matching engine runs (weekly vs
 * daily). See DAILY_MATCHING_IMPLEMENTATION_PLAN.md for the full rationale;
 * this file is the "Фаза 0" scaffold that plan describes.
 *
 * Nothing outside this module should read `process.env.DROP_CADENCE`
 * directly — every consumer imports `CADENCE` and reads a field off it.
 * The `weekly` profile is a byte-for-byte copy of today's hardcoded
 * constants (see `cadence.test.ts`), so selecting it changes nothing.
 */

export interface DropCadence {
  /** node-cron expression for the main matching batch. */
  cron: string;
  /** Nominal interval between batches, in ms (7 days for weekly, 1 day for daily). */
  intervalMs: number;

  /**
   * How a proposal's reply deadline is computed from `dispatchedAt`.
   *
   * `"fixed"` — a flat TTL (`decisionWindowMs`) from dispatch, independent of
   * the next batch's timing. This is today's weekly behavior: batches are 7
   * days apart, so a flat 24h window never collides with the next drop.
   *
   * `"anchored"` — the deadline is pinned to `decisionBufferMs` before the
   * next batch (floored at `dispatchedAt + minDecisionMs` for out-of-cycle
   * pitches, e.g. Rematch). This only makes sense once batches are frequent
   * enough that "flat 24h" would collide with the next one (daily cadence).
   *
   * These are NOT interchangeable via constants alone — applying the
   * `anchored` formula to a 7-day interval would balloon the weekly decision
   * window to ~7 days. Each cadence profile picks its own strategy plus the
   * fields that strategy actually reads.
   */
  deadlineStrategy: "fixed" | "anchored";
  /** Used only when `deadlineStrategy === "fixed"`. */
  decisionWindowMs?: number;
  /** Used only when `deadlineStrategy === "anchored"`. */
  decisionBufferMs?: number;
  /** Used only when `deadlineStrategy === "anchored"`. */
  minDecisionMs?: number;

  /** Candidate re-eligibility cooldown after a match (`MATCH_COOLDOWN_MS`). */
  cooldownMs: number;
  /** Starvation-bonus slope per missed cycle (`STARVATION_ALPHA`). */
  starvationAlpha: number;

  /** node-cron expression for the no-match notice job — a separate constant
   *  from `cron` (D4), even though weekly's default value still shadows the
   *  batch's own day/time. The actual "not every drop" throttling is a
   *  query-level filter (`famineNoticeIntervalMs`), not this schedule. */
  noMatchNoticeCron: string;
  /** Minimum gap between two famine notices to the same user — the query-level
   *  throttle that makes the notice cadence genuinely independent of how often
   *  the batch (and this cron) actually fires (D4). Weekly: 7 days (one notice
   *  per weekly drop, unchanged). Daily: ~2.5 days ("every 2-3 days"), even
   *  though the cron below still ticks daily. */
  famineNoticeIntervalMs: number;
  /**
   * Tier threshold (in units of `intervalMs` — weeks for weekly, days for
   * daily) at which the famine ticket discount is granted. Compared directly
   * against `computeTier`'s return value, which is itself denominated in the
   * same units — see `no-match-notifier.ts`.
   */
  famineDiscountMinTier: number;

  /** Profiler rush-window threshold before a drop (`PROFILER_RUSH_WINDOW_HOURS`). */
  profilerRushWindowMs: number;

  /** Proposal-phase nudge offsets from dispatch: [nudge1, nudge2]. */
  proposalNudgeOffsetsMs: [number, number];
  /** Deadline heads-up lead time before the reply deadline. */
  proposalDeadlineNudgeLeadMs: number;
  /** Scheduling-phase nudge offsets: [nudge1, nudge2]. */
  schedNudgeOffsetsMs: [number, number];
  /** Venue-phase nudge offsets: [nudge1, nudge2]. */
  venueNudgeOffsetsMs: [number, number];
  /** Planning-stall "still in?" check-in delay. */
  stallCheckInMs: number;
  /** Planning-stall cancellation timeout. */
  stallTimeoutMs: number;

  /** Rematch: no purchases in the run-up to the next batch. */
  rematchBlackoutMs: number;
  /** Rematch: max settled purchases per `rematchWindowMs`. */
  rematchMaxPerInterval: number;
  /** Rematch: rolling window the purchase-count limit is measured over. */
  rematchWindowMs: number;
  /** Rematch: cooldown between purchases. */
  rematchCooldownMs: number;
  /** Rematch: how long a candidate is protected from a repeat gift pitch. */
  rematchGiftCapMs: number;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Weekly — every value below is today's existing hardcoded constant,
 * unchanged. `cadence.test.ts` pins this against the real constants so any
 * future edit to one without the other is caught immediately.
 */
const WEEKLY: DropCadence = {
  cron: "0 18 * * 4",
  intervalMs: 7 * DAY,

  deadlineStrategy: "fixed",
  decisionWindowMs: 24 * HOUR,

  cooldownMs: 24 * HOUR,
  starvationAlpha: 0.05,

  noMatchNoticeCron: "15 18 * * 4",
  famineNoticeIntervalMs: 7 * DAY,
  famineDiscountMinTier: 2,

  profilerRushWindowMs: 48 * HOUR,

  proposalNudgeOffsetsMs: [3 * HOUR, 10 * HOUR],
  proposalDeadlineNudgeLeadMs: 2 * HOUR,
  schedNudgeOffsetsMs: [6 * HOUR, 12 * HOUR],
  venueNudgeOffsetsMs: [6 * HOUR, 12 * HOUR],
  stallCheckInMs: 24 * HOUR,
  stallTimeoutMs: 48 * HOUR,

  rematchBlackoutMs: 6 * HOUR,
  rematchMaxPerInterval: 2,
  rematchWindowMs: 7 * DAY,
  rematchCooldownMs: 24 * HOUR,
  rematchGiftCapMs: 7 * DAY,
};

/**
 * Daily — D1–D9 values from DAILY_MATCHING_IMPLEMENTATION_PLAN.md §0.
 * Not live in production; selected only via `DROP_CADENCE=daily`.
 */
const DAILY: DropCadence = {
  cron: "0 18 * * *",
  intervalMs: DAY,

  deadlineStrategy: "anchored",
  decisionBufferMs: 30 * MIN,
  minDecisionMs: 90 * MIN,

  cooldownMs: 6 * HOUR,
  starvationAlpha: 0.05 / 7,

  noMatchNoticeCron: "15 18 * * *",
  famineNoticeIntervalMs: 2.5 * DAY,
  famineDiscountMinTier: 7,

  profilerRushWindowMs: 4 * HOUR,

  proposalNudgeOffsetsMs: [2 * HOUR, 8 * HOUR],
  proposalDeadlineNudgeLeadMs: 1.5 * HOUR,
  schedNudgeOffsetsMs: [3 * HOUR, 6 * HOUR],
  venueNudgeOffsetsMs: [3 * HOUR, 6 * HOUR],
  stallCheckInMs: 12 * HOUR,
  stallTimeoutMs: 24 * HOUR,

  rematchBlackoutMs: 6 * HOUR,
  rematchMaxPerInterval: 2,
  rematchWindowMs: 7 * DAY,
  rematchCooldownMs: 24 * HOUR,
  rematchGiftCapMs: 7 * DAY,
};

export const CADENCES: Record<"weekly" | "daily", DropCadence> = {
  weekly: WEEKLY,
  daily: DAILY,
};

export type CadenceKey = keyof typeof CADENCES;

/**
 * Resolve a cadence key to its profile, failing loudly on an unknown value
 * instead of silently returning `undefined` (the class of bug this whole
 * migration exists to eliminate — see `next-batch.ts`'s `parseWeeklyCron`).
 * Exported (not just used internally) so it's directly unit-testable without
 * re-importing the module under a different `process.env`.
 */
export function resolveCadence(key: string | undefined): DropCadence {
  const resolved = key ?? "weekly";
  const profile = CADENCES[resolved as CadenceKey];
  if (!profile) {
    throw new Error(
      `Unknown DROP_CADENCE: "${resolved}" (expected one of: ${Object.keys(CADENCES).join(", ")})`,
    );
  }
  return profile;
}

/** The active cadence profile, resolved once at module load from `DROP_CADENCE`. */
export const CADENCE: DropCadence = resolveCadence(process.env.DROP_CADENCE);
