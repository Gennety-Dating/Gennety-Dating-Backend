/**
 * The single source of truth for a match proposal's reply deadline.
 *
 * Before this file existed, the 24h decision window was declared TWICE,
 * independently: `MATCH_TTL_MS` (match-expiry.ts, the only one that actually
 * gates the sweep that kills a stale proposal) and `PROPOSAL_TTL_MS`
 * (countdown-plate.ts, feeding the countdown button, the pitch's initial
 * copy, the deadline nudge, and the iOS-facing `proposalDeadlineAt` field).
 * The two constants happened to agree because nobody had a reason to edit
 * just one — but nothing enforced that, and a daily cadence needs a genuinely
 * different formula for `weekly` vs `daily`, not just a different number.
 *
 * See `DAILY_MATCHING_IMPLEMENTATION_PLAN.md` §1.2 for the full rationale.
 * The two strategies are NOT interchangeable via constants alone:
 *
 *   - `"fixed"` (weekly, unchanged behavior): the deadline is a flat TTL from
 *     `dispatchedAt`, entirely independent of when the next batch runs. This
 *     is what makes weekly's 24h window never race the next Thursday batch —
 *     7 days is nowhere near 24h.
 *   - `"anchored"` (daily): the deadline is pinned to `decisionBufferMs`
 *     before the NEXT batch — because under a daily cadence, a flat 24h TTL
 *     would land almost exactly on the following day's batch, turning "did
 *     the sweep or the batch fire first" into a real race. Floored at
 *     `dispatchedAt + minDecisionMs` so an out-of-cycle pitch (Rematch) never
 *     gets an unreasonably short window.
 *
 * Applying the `anchored` formula to the `weekly` profile would balloon its
 * decision window from 24h to ~7 days (the next batch is a week away) — this
 * is exactly the regression `cadence.test.ts` and this module's own tests
 * exist to catch.
 */

import { CADENCE } from "@gennety/shared";
import { getNextBatchDate } from "./next-batch.js";

/**
 * The instant a dispatched proposal's reply window closes. Pure function of
 * `dispatchedAt` and the active `CADENCE` profile.
 */
export function deadlineFor(dispatchedAt: Date): Date {
  if (CADENCE.deadlineStrategy === "fixed") {
    return new Date(dispatchedAt.getTime() + CADENCE.decisionWindowMs!);
  }
  return new Date(
    Math.max(
      getNextBatchDate(dispatchedAt).getTime() - CADENCE.decisionBufferMs!,
      dispatchedAt.getTime() + CADENCE.minDecisionMs!,
    ),
  );
}

/**
 * Minutes remaining until the deadline (negative once it has passed). The
 * single helper every countdown-rendering surface should call instead of
 * doing its own `deadline - now` arithmetic.
 */
export function minutesLeftUntilDeadline(
  dispatchedAt: Date,
  now: Date = new Date(),
): number {
  const remainingMs = deadlineFor(dispatchedAt).getTime() - now.getTime();
  return Math.floor(remainingMs / 60_000);
}
