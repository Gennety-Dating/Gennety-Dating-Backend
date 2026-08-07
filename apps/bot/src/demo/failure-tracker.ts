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
 */

export interface FailureTracker {
  /** Record a refusal; returns the new consecutive count for this action. */
  note(userId: string, actionKey: string): number;
  /** True once this action has been given up on and must not be retried. */
  abandoned(userId: string, actionKey: string): boolean;
  /** Forget this visitor entirely (success, state change, or `/restart`). */
  clear(userId: string): void;
}

export function createFailureTracker(maxFailures: number): FailureTracker {
  const streaks = new Map<string, { key: string; count: number }>();

  return {
    note(userId, actionKey) {
      const prev = streaks.get(userId);
      const count = prev && prev.key === actionKey ? prev.count + 1 : 1;
      streaks.set(userId, { key: actionKey, count });
      return count;
    },

    abandoned(userId, actionKey) {
      const seen = streaks.get(userId);
      return seen !== undefined && seen.key === actionKey && seen.count >= maxFailures;
    },

    clear(userId) {
      streaks.delete(userId);
    },
  };
}
