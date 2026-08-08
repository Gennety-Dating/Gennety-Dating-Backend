/**
 * How many times in a row the demo has tried the same move and been refused.
 *
 * The driver re-derives what is owed on every tick, which is what keeps demo
 * mode from rotting — but it also means a move that gets refused is re-derived
 * and re-attempted forever. That is not theoretical: a puppet with an empty
 * ticket wallet logged `insufficient-balance` **1500 times** across several
 * hours while the visitor sat in front of a demo that had silently died, and
 * the tick summary said `acted=1 errors=0` the whole time.
 *
 * Kept apart from `driver.ts` because it is the one piece of that logic with no
 * I/O in it, so it can be tested without a database, a bot or a clock — the
 * same split `decide.ts` already makes for the decision table.
 *
 * A streak is per (visitor, action): a DIFFERENT action resets it, because the
 * state moved on and whatever was failing is no longer what we are doing.
 *
 * **Giving up is a pause, never a retirement** (added 2026-08-08). The first
 * version abandoned an action permanently — the streak lived until a different
 * action, a success, or `/restart`. That turned any *self-healing* refusal into
 * a dead demo: a visitor declined a pitch, which dirtied their embedding, which
 * made the allocator refuse for the ~5 minutes the refresh cron needed; the
 * three refusals burned in ~36 seconds, and the demo never tried again even
 * though the condition had cleared. Found live, with a ready visitor sitting in
 * front of a bot that had quietly stopped.
 *
 * The specific cause is fixed at its source (`ensureFreshEmbeddings`), so this
 * is the net under the ones nobody has hit yet: after `retryAfterMs` a single
 * probe is allowed through. The count is NOT reset by that probe, which is what
 * keeps the flood shut — a probe that fails again pushes the deadline out and
 * cannot re-trigger the give-up message, because the driver announces only on
 * the tick where the streak first equals the ceiling.
 */

export interface FailureTracker {
  /** Record a refusal; returns the new consecutive count for this action. */
  note(userId: string, actionKey: string, now?: number): number;
  /** True while this action is given up on and must not be retried yet. */
  abandoned(userId: string, actionKey: string, now?: number): boolean;
  /** Forget this visitor entirely (success, state change, or `/restart`). */
  clear(userId: string): void;
}

/**
 * How long a given-up action rests before one probe is allowed through.
 *
 * Two minutes: long enough that a genuinely broken step logs once and then
 * roughly thirty times an hour instead of twelve hundred, short enough that a
 * transient cause clears well inside the fifteen minutes a demo takes to walk.
 */
export const DEMO_RETRY_AFTER_MS = 2 * 60_000;

export function createFailureTracker(
  maxFailures: number,
  retryAfterMs: number = DEMO_RETRY_AFTER_MS,
): FailureTracker {
  const streaks = new Map<string, { key: string; count: number; lastAt: number }>();

  return {
    note(userId, actionKey, now = Date.now()) {
      const prev = streaks.get(userId);
      const count = prev && prev.key === actionKey ? prev.count + 1 : 1;
      streaks.set(userId, { key: actionKey, count, lastAt: now });
      return count;
    },

    abandoned(userId, actionKey, now = Date.now()) {
      const seen = streaks.get(userId);
      if (seen === undefined || seen.key !== actionKey) return false;
      if (seen.count < maxFailures) return false;
      return now - seen.lastAt < retryAfterMs;
    },

    clear(userId) {
      streaks.delete(userId);
    },
  };
}
