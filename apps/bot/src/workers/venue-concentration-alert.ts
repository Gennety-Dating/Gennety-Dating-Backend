/**
 * Weekly venue-concentration alert (VENUE_ENGINE_IMPROVEMENT_PLAN part 6).
 *
 * The engine fails silently: dates keep getting scheduled, so nothing throws
 * and nothing alerts while one venue quietly carries the city. This worker is
 * the alarm — it reads the same `venue_selection_logs` aggregation the admin
 * dashboard shows and pushes a line into the founder ops DM when a city's top
 * venue crosses the configured share.
 *
 * Deliberately NOT deduplicated by a marker table (unlike `NoMatchNotice`): a
 * concentration problem that is still there next week SHOULD be reported
 * again. The weekly cadence of the cron is the whole rate limit.
 */

import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { notifyFounderVenueConcentration } from "../services/founder-notify.js";
import {
  CONCENTRATION_ROW_LIMIT,
  computeVenueConcentration,
  parsePoolSizes,
  type SelectionLogRow,
} from "../admin/utils/venue-concentration.js";

export interface VenueConcentrationAlertResult {
  citiesScanned: number;
  alerts: number;
  skipped: boolean;
  /** The scan hit its bound, so every share below is off a partial window. */
  truncated: boolean;
}

export async function venueConcentrationAlertTick(
  now = new Date(),
): Promise<VenueConcentrationAlertResult> {
  // The founder feed is the only delivery channel, so an alert with the feed
  // off would compute an aggregation nobody receives.
  if (!env.VENUE_CONCENTRATION_ALERT_ENABLED || !env.FOUNDER_NOTIFY_ENABLED) {
    return { citiesScanned: 0, alerts: 0, skipped: true, truncated: false };
  }

  const windowDays = env.VENUE_CONCENTRATION_ALERT_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.venueSelectionLog.findMany({
    where: { mode: "live", createdAt: { gte: since } },
    select: { cityKey: true, selectedPlaceId: true, failureReason: true, topCandidates: true },
    orderBy: { createdAt: "desc" },
    take: CONCENTRATION_ROW_LIMIT,
  });

  // Rows come newest-first across every city, so a truncated window can drop a
  // quiet city's runs entirely and leave the shares below computed off a
  // partial denominator. An alarm that can be quietly wrong is worse than one
  // that is absent, so say so rather than reporting the number as complete.
  const truncated = rows.length === CONCENTRATION_ROW_LIMIT;
  if (truncated) {
    console.warn(
      `[venue-concentration] scan hit the ${CONCENTRATION_ROW_LIMIT}-row bound; shares are computed off a partial window`,
    );
  }

  const parsed: SelectionLogRow[] = rows.map((row) => ({
    cityKey: row.cityKey,
    selectedPlaceId: row.selectedPlaceId,
    failureReason: row.failureReason,
    poolSizes: parsePoolSizes(row.topCandidates),
  }));

  const cities = computeVenueConcentration(parsed);
  const thresholdPct = env.VENUE_CONCENTRATION_ALERT_THRESHOLD_PCT;
  const alerts = cities.flatMap((city) => {
    const top = city.topVenues[0];
    if (!top || city.assignments === 0) return [];
    const sharePct = top.share * 100;
    if (sharePct <= thresholdPct) return [];
    return [{
      cityKey: city.cityKey,
      placeId: top.placeId,
      count: top.count,
      assignments: city.assignments,
      sharePct,
      uniqueVenues: city.uniqueVenues,
    }];
  });

  await notifyFounderVenueConcentration(alerts, windowDays);
  return { citiesScanned: cities.length, alerts: alerts.length, skipped: false, truncated };
}
