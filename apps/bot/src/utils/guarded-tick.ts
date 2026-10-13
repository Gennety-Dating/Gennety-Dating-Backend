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

/**
 * How long one run may stay in flight before a skipped tick calls it stuck.
 *
 * Single-flight has a blind spot the failure counter cannot see: a run whose
 * promise never settles (an upstream call with no timeout, a lock nobody
 * releases) neither fails nor succeeds, so every later tick is skipped with a
 * `console.warn` and the job is silently off until the next restart. Half an
 * hour is longer than any legitimate run of a frequent job (the longest paced
 * sweeps are bounded to minutes) and is only ever checked when a tick is
 * actually skipped, so a once-a-day job that runs long is never flagged.
 */
const STUCK_ALERT_AFTER_MS = 30 * 60 * 1000;

export interface GuardedTickDeps {
  /** Injected in tests; defaults to the founder ops feed. */
  notifyHealth?: (
    subsystem: string,
    state: SubsystemHealthState,
    consecutiveFailures: number,
  ) => Promise<void>;
  /**
   * Consecutive failures before the job is announced as degraded (default 3).
   *
   * Three is right for a job that runs every few minutes, where one failure is
   * a blip. It is wrong for a job that runs once a week (A13-M24): three
   * failures in a row is three weeks without a drop, so those jobs pass 1 —
   * the first failure IS the outage.
   */
  failureAlertThreshold?: number;
  /**
   * A run in flight longer than this when the next tick comes is announced as
   * stuck (default 30 min). Jobs that legitimately pace for longer — the drop's
   * dispatch — pass their own.
   */
  stuckAlertAfterMs?: number;
  /** Injected in tests. */
  now?: () => number;
}

export type SubsystemHealthState = "degraded" | "recovered" | "stuck";

/**
 * Ticks running right now, by name — what a graceful shutdown waits for
 * (A13-M21). A count per name rather than a set: two schedules may share one.
 */
const runningTicks = new Map<string, number>();
const idleWaiters = new Set<() => void>();

function tickStarted(name: string): void {
  runningTicks.set(name, (runningTicks.get(name) ?? 0) + 1);
}

function tickFinished(name: string): void {
  const left = (runningTicks.get(name) ?? 1) - 1;
  if (left > 0) runningTicks.set(name, left);
  else runningTicks.delete(name);
  if (runningTicks.size === 0) {
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }
}

/** Names of the guarded ticks still in flight. */
export function runningGuardedTicks(): string[] {
  return [...runningTicks.keys()];
}

/** Resolves `true` once no guarded tick is running, `false` if `timeoutMs` passes first. */
export function waitForGuardedTicksIdle(timeoutMs: number): Promise<boolean> {
  if (runningTicks.size === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onIdle = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      idleWaiters.delete(onIdle);
      resolve(false);
    }, timeoutMs);
    idleWaiters.add(onIdle);
  });
}

export function guardedTick(
  name: string,
  task: () => Promise<unknown>,
  deps: GuardedTickDeps = {},
): () => void {
  let running = false;
  let runStartedAt = 0;
  let skippedWhileRunning = 0;
  let consecutiveFailures = 0;
  let degradedAlertSent = false;
  let stuckAlertSent = false;
  const alertThreshold = Math.max(1, deps.failureAlertThreshold ?? FAILURE_ALERT_THRESHOLD);
  const stuckAfterMs = Math.max(0, deps.stuckAlertAfterMs ?? STUCK_ALERT_AFTER_MS);
  const now = deps.now ?? Date.now;

  const notifyHealth = async (
    state: SubsystemHealthState,
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
      skippedWhileRunning += 1;
      const elapsedMs = now() - runStartedAt;
      if (elapsedMs >= stuckAfterMs) {
        console.error(
          `[cron] "${name}" in flight for ${Math.round(elapsedMs / 1000)}s — ` +
            `${skippedWhileRunning} tick(s) skipped; the job is stuck`,
        );
        if (!stuckAlertSent) {
          stuckAlertSent = true;
          void notifyHealth("stuck", skippedWhileRunning);
        }
      } else {
        console.warn(`[cron] "${name}" still in flight — skipping this tick`);
      }
      return;
    }
    running = true;
    runStartedAt = now();
    skippedWhileRunning = 0;
    tickStarted(name);
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
      .then(() => {
        const previousFailures = consecutiveFailures;
        consecutiveFailures = 0;
        // Recovery is announced only when a degradation was, so a single
        // failed tick stays what it is: an entry in the log.
        // Not awaited, here or below: the alert is a Telegram send, and the
        // in-flight flag clears in `finally` — awaiting it kept a slow Bot API
        // call holding the job "running" and its next ticks skipped.
        if (degradedAlertSent) {
          degradedAlertSent = false;
          void notifyHealth("recovered", previousFailures);
        }
      })
      .catch((err) => {
        console.error(`[cron] "${name}" tick failed:`, err);
        consecutiveFailures += 1;
        if (consecutiveFailures >= alertThreshold && !degradedAlertSent) {
          degradedAlertSent = true;
          void notifyHealth("degraded", consecutiveFailures);
        }
      })
      .finally(() => {
        running = false;
        tickFinished(name);
        if (stuckAlertSent) {
          // The stuck run did end after all; say so, whichever way it ended.
          stuckAlertSent = false;
          console.warn(
            `[cron] "${name}" stuck run finished after ${Math.round((now() - runStartedAt) / 1000)}s`,
          );
          void notifyHealth("recovered", skippedWhileRunning);
        }
      });
  };
}
