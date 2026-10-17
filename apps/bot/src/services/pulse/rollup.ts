import { PULSE_ANALYTICS } from "@gennety/shared";
import { ONBOARDING_QUESTIONS } from "../onboarding-collector.js";
import { runDetectors, shiftDay } from "./detectors.js";
import { computeMetricRows, dayKey } from "./rollup-math.js";
import {
  loadActivityDays,
  loadClientEvents,
  loadExcludedUserIds,
  loadFunnelMatches,
  loadOptInUsers,
  loadSignups,
  loadStepEvents,
  loadStuckPeople,
  replaceMetricDays,
  writeInsights,
} from "./source.js";

/**
 * Pulse nightly rollup (docs/product/domains/pulse-analytics.md §5).
 *
 * One run: load the trailing `rollupWindowDays` UTC days of every source,
 * compute `metric_days` for the whole window, rewrite the window, then run the
 * detectors over the fresh rows and upsert `insights`.
 *
 * Idempotent and self-healing by construction — the window is rewritten whole
 * every night, so a skipped night or a late-arriving batch (a phone that was
 * offline for a day sends its queue later; `occurred_at` is still the day it
 * happened) is absorbed by the next run. Same shape as `virality-rollup`.
 *
 * Today is included even though it has just begun: its rows are a partial day
 * and are rewritten tomorrow, while the detectors read only complete days
 * (`asOf` = yesterday), so a half-day never looks like a collapse.
 */

/**
 * Server-side conversational step order — the collector's question list minus
 * the terminal sentinel, exactly as `/admin/analytics/onboarding-funnel` builds it.
 */
export const SERVER_ONBOARDING_STEPS: readonly string[] = ONBOARDING_QUESTIONS.filter(
  (q) => q !== "complete",
);

export interface PulseRollupResult {
  from: string;
  to: string;
  /** Last complete day the detectors judged. */
  asOf: string;
  events: number;
  eventsTruncated: boolean;
  metricRows: number;
  insights: number;
  resolved: number;
  stuck: number;
}

export async function runPulseRollup(now: Date = new Date()): Promise<PulseRollupResult> {
  const today = dayKey(now);
  const from = shiftDay(today, -(PULSE_ANALYTICS.rollupWindowDays - 1));
  const asOf = shiftDay(today, -1);
  const fromAt = new Date(`${from}T00:00:00.000Z`);
  const toAt = new Date(`${shiftDay(today, 1)}T00:00:00.000Z`);
  const days: string[] = [];
  for (let d = from; d <= today; d = shiftDay(d, 1)) days.push(d);

  const excluded = await loadExcludedUserIds();
  const [events, stepEvents, activity, signups, matches, optInUsers, stuck] = await Promise.all([
    loadClientEvents(fromAt, toAt, excluded),
    loadStepEvents(fromAt, toAt),
    loadActivityDays(fromAt, toAt),
    loadSignups(fromAt, toAt),
    loadFunnelMatches(fromAt, toAt),
    loadOptInUsers(),
    loadStuckPeople(now),
  ]);

  const rows = computeMetricRows({
    days,
    events: events.rows,
    stepEvents,
    serverSteps: SERVER_ONBOARDING_STEPS,
    activity,
    signups,
    matches,
    optInUsers,
  });
  const computedAt = new Date();
  const written = await replaceMetricDays(from, today, rows, computedAt);

  const drafts = runDetectors({ rows, asOf, stuck, serverSteps: SERVER_ONBOARDING_STEPS });
  const { upserted, resolved } = await writeInsights(drafts, computedAt);

  return {
    from,
    to: today,
    asOf,
    events: events.rows.length,
    eventsTruncated: events.truncated,
    metricRows: written,
    insights: upserted,
    resolved,
    stuck: stuck.length,
  };
}
