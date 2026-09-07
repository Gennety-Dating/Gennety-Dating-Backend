/**
 * Single-flight guard for scheduled jobs.
 *
 * `node-cron` and `setInterval` both fire on a fixed wall-clock cadence and do
 * NOT wait for the previous run to finish. When a tick runs longer than its
 * interval (e.g. a date-lifecycle tick stuck on a slow LLM / Places call), the
 * next tick starts concurrently and re-selects the same rows — the
 * read-then-write idempotency markers (`findMany(marker:null) → work →
 * update(marker)`) are checked before the awaited side-effects and written
 * after, so two overlapping runs both pass the "not yet sent" check and both
 * send. Result: duplicate DMs / pushes (H2 in the audit).
 *
 * `guardedTick` returns a fire-and-forget callback suitable for
 * `cron.schedule(expr, cb)` / `setInterval(cb, ms)` that:
 *   - skips (and logs) the tick if the previous run is still in flight,
 *   - centralises error logging so a rejected task never becomes an
 *     unhandled rejection,
 *   - always clears the in-flight flag in `finally`.
 *
 * The returned callback is intentionally `() => void` (not async): cron/Node
 * ignore the return value, and swallowing here keeps the scheduler decoupled
 * from the task's promise.
 *
 * It is also where a job's HEALTH is noticed, and that is deliberate. Before
 * this, exactly one worker in the product told anyone when it broke — the
 * status timer, through its own bespoke runner — while twenty-five other jobs
 * (matching, payments sweeps, verification, refunds, retention) failed into
 * `console.error` on a droplet nobody is watching. A whole subsystem could stop
 * for days and the first signal would be a user asking why nothing happened.
 * Every one of those jobs already passes through this function, so this is the
 * one place that can see all of them.
 */

/** Consecutive failures before a job is called broken rather than unlucky. */
const FAILURE_ALERT_THRESHOLD = 3;

export interface GuardedTickDeps {
  /** Injected in tests; defaults to the founder ops feed. */
  notifyHealth?: (
    subsystem: string,
    state: "degraded" | "recovered",
    consecutiveFailures: number,
  ) => Promise<void>;
}

export function guardedTick(
  name: string,
  task: () => Promise<unknown>,
  deps: GuardedTickDeps = {},
): () => void {
  let running = false;
  let consecutiveFailures = 0;
  let degradedAlertSent = false;

  const notifyHealth = async (
    state: "degraded" | "recovered",
    failures: number,
  ): Promise<void> => {
    try {
      const notify =
        deps.notifyHealth ??
        (await import("../services/founder-notify.js")).notifyFounderSubsystemHealth;
      await notify(name, state, failures);
    } catch (err) {
      // The alert is the last line, so it must never become the failure it was
      // reporting: a broken notifier would otherwise mask every broken job.
      console.warn(`[cron] "${name}" health notify failed:`, err);
    }
  };

  return () => {
    if (running) {
      console.warn(`[cron] "${name}" still in flight — skipping this tick`);
      return;
    }
    running = true;
    // Invoke synchronously so the in-flight flag reflects the run immediately;
    // normalise a synchronous throw into a rejection so the chain below always
    // logs it and clears the flag in `finally`.
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(task());
    } catch (err) {
      result = Promise.reject(err);
    }
    void result
      .then(async () => {
        const previousFailures = consecutiveFailures;
        consecutiveFailures = 0;
        // Recovery is announced only when a degradation was, so a single
        // failed tick stays what it is: an entry in the log.
        if (degradedAlertSent) {
          degradedAlertSent = false;
          await notifyHealth("recovered", previousFailures);
        }
      })
      .catch(async (err) => {
        console.error(`[cron] "${name}" tick failed:`, err);
        consecutiveFailures += 1;
        if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD && !degradedAlertSent) {
          degradedAlertSent = true;
          await notifyHealth("degraded", consecutiveFailures);
        }
      })
      .finally(() => {
        running = false;
      });
  };
}
