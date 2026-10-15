import { runPulseRollup, type PulseRollupResult } from "../services/pulse/rollup.js";

/**
 * Pulse nightly rollup tick (docs/product/domains/pulse-analytics.md §5.1).
 *
 * Registered in `index.ts` under `PULSE_ROLLUP_CRON_SCHEDULE` (default
 * `10 1 * * *`, UTC) through `guardedTick`, like `virality-rollup`. UTC because
 * every bucket is a UTC calendar day: the run has to come after the day it
 * closes, not after Kyiv wakes up. 01:10 rather than 00:xx so the DAU reconcile
 * (00:20 UTC) has already repaired `user_activity_days` for the closed day.
 *
 * The heavy lifting is in `services/pulse/rollup.ts`; this wrapper exists so
 * the cron registration, the log line and the "is the feature on" decision sit
 * in one testable place.
 */

export interface PulseRollupTickResult extends PulseRollupResult {
  skipped?: false;
}

export async function pulseRollupTick(
  now: Date = new Date(),
  options: { enabled?: boolean } = {},
): Promise<PulseRollupTickResult | { skipped: true }> {
  if (options.enabled === false) return { skipped: true };
  return runPulseRollup(now);
}

/** One log line per run — the numbers an operator checks first. */
export function formatPulseRollupLog(r: PulseRollupTickResult | { skipped: true }): string {
  if ("skipped" in r && r.skipped) return "[pulse-rollup] skipped (PULSE_ROLLUP_ENABLED=false)";
  const res = r as PulseRollupTickResult;
  return (
    `[pulse-rollup] ${res.from}..${res.to} asOf=${res.asOf} events=${res.events}` +
    `${res.eventsTruncated ? " (TRUNCATED)" : ""} metricRows=${res.metricRows} ` +
    `insights=${res.insights} resolved=${res.resolved} stuck=${res.stuck}`
  );
}
