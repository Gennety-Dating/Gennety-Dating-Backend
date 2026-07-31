/**
 * Venue concentration analytics (VENUE_ENGINE_IMPROVEMENT_PLAN part 6).
 *
 * The engine's failure mode is silent: it keeps scheduling dates, so nothing
 * errors, nothing alerts, and one venue quietly carries most of the city. That
 * is exactly how the `.slice(0, 20)` defect survived — it was found by a manual
 * query against production, not by anything the product could see on its own.
 *
 * This module is the pure aggregation over `venue_selection_logs`. Keeping it
 * free of Prisma means the alerting worker and the admin route share one
 * definition of "concentrated", and the definition is testable without a
 * database.
 */

/** One `venue_selection_logs` row, reduced to the fields analytics reads. */
export interface SelectionLogRow {
  cityKey: string | null;
  selectedPlaceId: string | null;
  failureReason: string | null;
  /** `topCandidates.poolSizes`, absent on rows written before part 6. */
  poolSizes: PoolSizes | null;
}

export interface PoolSizes {
  curatedInBox: number;
  curatedEligible: number;
  placesAdded: number;
  ranked: number;
}

export interface VenueShare {
  placeId: string;
  count: number;
  /** 0..1 share of the city's successful assignments in the window. */
  share: number;
}

export interface FunnelStat {
  median: number;
  p90: number;
  /** How many rows carried a funnel at all (older rows carry none). */
  samples: number;
}

export interface CityConcentration {
  cityKey: string;
  /** Runs that assigned a venue. The denominator for every share below. */
  assignments: number;
  /** Runs that ended without a venue, by `failureReason` prefix. */
  failures: number;
  failureReasons: Record<string, number>;
  uniqueVenues: number;
  topVenues: VenueShare[];
  /**
   * Sum of squared shares — 1.0 when one venue takes everything, 1/n when n
   * venues split evenly. Same shape as HHI; it is a summary, not a threshold.
   */
  concentrationIndex: number;
  funnel: {
    curatedInBox: FunnelStat;
    curatedEligible: FunnelStat;
    placesAdded: FunnelStat;
    ranked: FunnelStat;
  };
}

export const UNKNOWN_CITY_KEY = "unknown";

/**
 * Scan bound, shared by the dashboard route and the alert worker so the two
 * cannot drift into disagreeing about what they measured.
 *
 * Hitting it is not benign: rows are read newest-first across ALL cities, so a
 * truncated window can drop a quiet city's runs entirely and hand back a share
 * computed from a partial denominator. Both readers must surface that rather
 * than reporting the number as if it were complete.
 */
export const CONCENTRATION_ROW_LIMIT = 5000;

/**
 * Parse `topCandidates` into a funnel, tolerating every shape the column has
 * ever held: the pre-part-6 bare array, the `{candidates, poolSizes}` object,
 * and anything malformed. Returns null rather than zeros — a row with no funnel
 * must not drag the median toward zero and fake a pool collapse.
 */
export function parsePoolSizes(topCandidates: unknown): PoolSizes | null {
  if (!topCandidates || typeof topCandidates !== "object" || Array.isArray(topCandidates)) return null;
  const raw = (topCandidates as { poolSizes?: unknown }).poolSizes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const curatedInBox = num(row.curatedInBox);
  const curatedEligible = num(row.curatedEligible);
  const placesAdded = num(row.placesAdded);
  const ranked = num(row.ranked);
  if (curatedInBox === null || curatedEligible === null || placesAdded === null || ranked === null) {
    return null;
  }
  return { curatedInBox, curatedEligible, placesAdded, ranked };
}

/** Percentile over an unsorted sample. Empty → zeroed stat with 0 samples. */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function funnelStat(values: number[]): FunnelStat {
  return { median: percentile(values, 0.5), p90: percentile(values, 0.9), samples: values.length };
}

/**
 * A failure reason carries a relaxation suffix (`no_candidates:<key>:<sides>`),
 * which would explode the grouping into one bucket per pair. Group by the head
 * plus the relaxation key, which is the actionable part.
 */
export function normalizeFailureReason(reason: string): string {
  const parts = reason.split(":");
  if (parts.length <= 1) return reason;
  return `${parts[0]}:${parts[1]}`;
}

/**
 * Aggregate selection logs into per-city concentration, sorted by assignment
 * volume so the busiest city leads.
 *
 * Shadow-mode rows must be excluded by the caller: they assign nothing, so
 * counting them would dilute every share with runs that never reached a user.
 */
export function computeVenueConcentration(
  rows: readonly SelectionLogRow[],
  topN = 5,
): CityConcentration[] {
  const byCity = new Map<string, SelectionLogRow[]>();
  for (const row of rows) {
    const key = row.cityKey ?? UNKNOWN_CITY_KEY;
    const bucket = byCity.get(key);
    if (bucket) bucket.push(row);
    else byCity.set(key, [row]);
  }

  const out: CityConcentration[] = [];
  for (const [cityKey, cityRows] of byCity) {
    const counts = new Map<string, number>();
    const failureReasons: Record<string, number> = {};
    let assignments = 0;
    let failures = 0;
    const funnels: Record<keyof PoolSizes, number[]> = {
      curatedInBox: [], curatedEligible: [], placesAdded: [], ranked: [],
    };

    for (const row of cityRows) {
      if (row.poolSizes) {
        funnels.curatedInBox.push(row.poolSizes.curatedInBox);
        funnels.curatedEligible.push(row.poolSizes.curatedEligible);
        funnels.placesAdded.push(row.poolSizes.placesAdded);
        funnels.ranked.push(row.poolSizes.ranked);
      }
      if (row.selectedPlaceId) {
        assignments += 1;
        counts.set(row.selectedPlaceId, (counts.get(row.selectedPlaceId) ?? 0) + 1);
        continue;
      }
      failures += 1;
      const reason = normalizeFailureReason(row.failureReason ?? "unknown");
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    }

    const shares = [...counts.entries()]
      .map(([placeId, count]) => ({ placeId, count, share: assignments > 0 ? count / assignments : 0 }))
      .sort((left, right) => right.count - left.count || left.placeId.localeCompare(right.placeId));

    out.push({
      cityKey,
      assignments,
      failures,
      failureReasons,
      uniqueVenues: counts.size,
      topVenues: shares.slice(0, topN),
      concentrationIndex: shares.reduce((sum, row) => sum + row.share * row.share, 0),
      funnel: {
        curatedInBox: funnelStat(funnels.curatedInBox),
        curatedEligible: funnelStat(funnels.curatedEligible),
        placesAdded: funnelStat(funnels.placesAdded),
        ranked: funnelStat(funnels.ranked),
      },
    });
  }

  return out.sort((left, right) => right.assignments - left.assignments || left.cityKey.localeCompare(right.cityKey));
}
