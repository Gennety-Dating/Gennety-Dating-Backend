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
 */
export function guardedTick(
  name: string,
  task: () => Promise<unknown>,
): () => void {
  let running = false;
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
      .catch((err) => console.error(`[cron] "${name}" tick failed:`, err))
      .finally(() => {
        running = false;
      });
  };
}
