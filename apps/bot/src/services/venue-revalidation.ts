import { Prisma, prisma } from "@gennety/db";
import {
  fetchPlaceDetails,
  MIN_RATING,
  MIN_RATING_COUNT,
  type PlaceDetails,
} from "./venue.js";

/**
 * Curated-venue re-validation cron (PRODUCT_SPEC §3.7).
 *
 * The curated base is verified only at seed time, so a place that closes (or
 * whose rating tanks) would otherwise stay `active=true` forever. This worker
 * periodically re-checks the oldest-verified active venues against Google
 * Places (Place Details, by stored `placeId`):
 *
 *   - not OPERATIONAL, or rating/review-count below the seed gate floor
 *     (`MIN_RATING` / `MIN_RATING_COUNT`) → `active = false`.
 *   - healthy → refresh `openingHours` + `utcOffsetMinutes` + `lastVerifiedAt`.
 *
 * Safety: an infra failure (fetch throws) NEVER deactivates a row — we don't
 * punish a venue for our own outage; it's retried next tick. A successful fetch
 * with an absent `businessStatus` is treated as inconclusive (refresh, keep
 * active) rather than a closure. Rows without a `placeId` (hand-entered) can't
 * be re-fetched and are simply not scanned.
 *
 * Mirrors the batch-scan shape of `workers/embedding-refresh.ts`.
 */

export const DEFAULT_VENUE_REVALIDATION_BATCH = 30;

export interface VenueRevalidationOptions {
  /** Cap rows touched per tick. Default 30 — bounds Places cost. */
  batchSize?: number;
  /** Test/runtime injection: Places API key. Defaults to `process.env.PLACES_API_KEY`. */
  apiKey?: string;
  /** Test injection: override the Place Details fetcher (no network). */
  fetchDetails?: (apiKey: string, placeId: string) => Promise<PlaceDetails>;
}

export interface VenueRevalidationResult {
  scanned: number;
  deactivated: number;
  refreshed: number;
  failed: number;
}

/** True if a successful Place Details fetch indicates the venue is no longer fit. */
function isNowUnfit(d: PlaceDetails): boolean {
  // Only an explicit non-OPERATIONAL status counts as closure; a null status
  // (field absent on an otherwise-OK fetch) is inconclusive, not a closure.
  if (d.businessStatus != null && d.businessStatus !== "OPERATIONAL") return true;
  if (d.rating != null && d.rating < MIN_RATING) return true;
  if (d.userRatingCount != null && d.userRatingCount < MIN_RATING_COUNT) return true;
  return false;
}

/**
 * One re-validation tick. Returns counts for logging. Never throws.
 */
export async function venueRevalidationTick(
  options: VenueRevalidationOptions = {},
): Promise<VenueRevalidationResult> {
  const batchSize = options.batchSize ?? DEFAULT_VENUE_REVALIDATION_BATCH;
  const apiKey = options.apiKey ?? process.env.PLACES_API_KEY ?? "";
  const fetchDetails = options.fetchDetails ?? fetchPlaceDetails;

  // Without a key (local dev) there's nothing to validate against.
  if (!apiKey) return { scanned: 0, deactivated: 0, refreshed: 0, failed: 0 };

  const rows = await prisma.curatedVenue.findMany({
    where: { active: true, placeId: { not: null } },
    orderBy: { lastVerifiedAt: { sort: "asc", nulls: "first" } },
    take: batchSize,
    select: { id: true, placeId: true, name: true },
  });

  let deactivated = 0;
  let refreshed = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.placeId) continue; // narrowed by query, belt-and-braces
    let details: PlaceDetails;
    try {
      details = await fetchDetails(apiKey, row.placeId);
    } catch (err) {
      // Infra failure — do NOT deactivate. Retry next tick.
      failed++;
      console.warn(
        `[venue-revalidation] details fetch failed for ${row.name} (${row.placeId}):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    if (isNowUnfit(details)) {
      await prisma.curatedVenue.update({
        where: { id: row.id },
        data: { active: false, lastVerifiedAt: new Date() },
      });
      deactivated++;
      console.log(
        `[venue-revalidation] deactivated "${row.name}" (status=${details.businessStatus} rating=${details.rating} reviews=${details.userRatingCount})`,
      );
    } else {
      await prisma.curatedVenue.update({
        where: { id: row.id },
        data: {
          openingHours: (details.openingHours ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          utcOffsetMinutes: details.utcOffsetMinutes,
          lastVerifiedAt: new Date(),
        },
      });
      refreshed++;
    }
  }

  return { scanned: rows.length, deactivated, refreshed, failed };
}
