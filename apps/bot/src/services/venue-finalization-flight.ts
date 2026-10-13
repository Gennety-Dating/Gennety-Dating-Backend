const activeFinalizations = new Map<string, Promise<void>>();
/** Matches whose state changed while a run was already reading it. */
const rerunRequested = new Map<string, () => Promise<void>>();

/**
 * Coalesce concurrent venue-finalization requests in this process. The
 * database status CAS remains the cross-process authority.
 *
 * Coalescing is trailing-edge, not leading-edge. A request that arrives while
 * a run is in flight is NOT answered by that run: the run may have read the row
 * before the newcomer's write committed. That was a real stall — both partners
 * confirm in the same second, A's run reads B as unconfirmed, B's request joins
 * A's run, the run returns "not both in yet", and nothing ever runs again (no
 * retry is stamped for a pair that never reached the selector). Now such a
 * request marks the match, and exactly one more run starts after the current
 * one, against a fresh read. Any number of mid-run requests still collapse into
 * that one extra run, and it is cheap once the match is `scheduled` (the
 * finalizers return on the status check).
 *
 * The rerun uses the most recent request's `finalize`; every caller's promise
 * settles when the last run it could depend on has finished.
 */
export function runVenueFinalizationOnce(
  matchId: string,
  finalize: () => Promise<void>,
): Promise<void> {
  const active = activeFinalizations.get(matchId);
  if (active) {
    rerunRequested.set(matchId, finalize);
    return active;
  }

  const run = (async () => {
    let next: (() => Promise<void>) | undefined = finalize;
    try {
      while (next) {
        const current: () => Promise<void> = next;
        rerunRequested.delete(matchId);
        try {
          await current();
        } catch (err) {
          // A failed run still owes the queued request its fresh read; only
          // the last run's failure is the caller's to see.
          if (!rerunRequested.has(matchId)) throw err;
          console.warn(`[venue-finalization] run failed, rerunning match=${matchId}:`, err);
        }
        next = rerunRequested.get(matchId);
      }
    } finally {
      // Nothing else can own the slot while this run holds it: every request
      // that arrived meanwhile joined it rather than starting its own.
      rerunRequested.delete(matchId);
      activeFinalizations.delete(matchId);
    }
  })();
  activeFinalizations.set(matchId, run);
  return run;
}
