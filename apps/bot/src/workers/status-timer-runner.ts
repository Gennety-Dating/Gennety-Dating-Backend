import type { StatusTimerResult } from "./status-timer.js";

const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
const FAILURE_ALERT_THRESHOLD = 3;

export interface StatusTimerRunnerDeps {
  tick: () => Promise<StatusTimerResult>;
  notifyHealth: (
    state: "degraded" | "recovered",
    consecutiveFailures: number,
  ) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Stateful health wrapper: heartbeat, threshold alert, and recovery notice. */
export function createStatusTimerRunner(deps: StatusTimerRunnerDeps): () => Promise<void> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console.log;
  let lastHeartbeatAt = 0;
  let consecutiveFailures = 0;
  let degradedAlertSent = false;

  return async () => {
    try {
      const result = await deps.tick();
      const previousFailures = consecutiveFailures;
      consecutiveFailures = 0;
      if (degradedAlertSent) {
        degradedAlertSent = false;
        await deps.notifyHealth("recovered", previousFailures);
      }

      const nowMs = now().getTime();
      const hadActivity =
        result.created > 0 ||
        result.edited > 0 ||
        result.repinned > 0 ||
        result.removedInactive > 0 ||
        result.transientFailures > 0 ||
        result.permanentFailures > 0;
      if (hadActivity || nowMs - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        log(`[status-timer] ${JSON.stringify(result)}`);
        lastHeartbeatAt = nowMs;
      }
    } catch (error) {
      consecutiveFailures++;
      if (
        consecutiveFailures >= FAILURE_ALERT_THRESHOLD &&
        !degradedAlertSent
      ) {
        degradedAlertSent = true;
        await deps.notifyHealth("degraded", consecutiveFailures);
      }
      throw error;
    }
  };
}
