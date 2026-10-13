/**
 * A fixed-cadence poll that never has two requests out at once.
 *
 * A bare `setInterval(() => void fetch…, 4000)` fires on schedule whether or
 * not the last request has come back. Under the 20 s client timeout
 * (`api.ts`) a slow network stacks up to five of them, and they land in
 * whatever order the network returns them — an older answer painting over a
 * newer one.
 *
 * Here the interval still ticks at exactly the same cadence, but a tick that
 * finds the previous request still out is skipped. Requests therefore go out
 * one after another and their answers land in the order they were asked: no
 * duplicate is sent while one is pending, and an answer is never older than
 * the one already applied. The poll does not pause on its own (on visibility
 * or anything else) — when it runs is still the caller's decision.
 */
export interface IntervalPoller {
  /** Start ticking. A no-op while already running. */
  start(): void;
  /** Stop ticking. A request already out still finishes and is handled. */
  stop(): void;
  readonly running: boolean;
}

export function createIntervalPoller(
  intervalMs: number,
  tick: () => Promise<void>,
): IntervalPoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const fire = (): void => {
    if (inFlight) return;
    inFlight = true;
    let pending: Promise<void>;
    try {
      pending = tick();
    } catch (err) {
      inFlight = false;
      throw err;
    }
    void pending.finally(() => {
      inFlight = false;
    });
  };

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(fire, intervalMs);
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    get running(): boolean {
      return timer !== null;
    },
  };
}
