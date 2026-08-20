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
 *   - healthy → refresh `openingHours`, `utcOffsetMinutes`, the quality/price
 *     metadata the V2 eligibility gate reads (`rating`, `userRatingCount`,
 *     `priceLevel`, `primaryType`, `editorialSummary`), the venue-change
 *     board's `photoRefs`, and `lastVerifiedAt`.
 *
 * The photo refs are the reason this worker is now load-bearing for a surface
 * it has nothing else to do with. The board used to resolve them itself, one
 * Place Details call per venue, cached only in process memory — so every deploy
 * threw the whole city away and the next board open paid for all of it again.
 * This call was already being made, daily, per venue; Place Details bills by the
 * most expensive field requested rather than by their sum, so carrying `photos`
 * in it costs at most what it already cost and removes that second lookup
 * entirely. What the board keeps is a fallback for rows this scan has not
 * reached yet (`withCuratedPhotos`), not a parallel source of truth.
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

/**
 * How many photo refs to keep per venue. Google returns ~10 for a typical
 * place in the one response, and the board shows at most
 * `VENUE_CHANGE_PHOTOS_PER_VENUE` (6) — the surplus is stored deliberately, so
 * raising that product number later is a read-side change rather than a
 * nine-day wait for the whole catalog to be re-scanned. Capped anyway: an
 * unbounded array on a row nobody audits is how a column quietly grows.
 */
export const CURATED_PHOTO_REFS_MAX = 10;

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
          // Persist the quality/price metadata too. The fitness check above
          // already reads these values; before 2026-07-30 they were then
          // thrown away, so a row seeded before the columns existed kept a
          // null `rating`/`priceLevel` forever — and the V2 eligibility gate
          // rejects exactly that (`quality_below_floor` / `unknown_price`).
          // The cron was silently unable to heal the rows it exists to keep
          // fresh. Only overwrite with a real value: a field absent from a
          // Places response must not erase what we already hold.
          ...(details.rating != null ? { rating: details.rating } : {}),
          ...(details.userRatingCount != null
            ? { userRatingCount: details.userRatingCount }
            : {}),
          ...(details.priceLevel != null ? { priceLevel: details.priceLevel } : {}),
          ...(details.primaryType != null ? { primaryType: details.primaryType } : {}),
          ...(details.editorialSummary != null
            ? { editorialSummary: details.editorialSummary }
            : {}),
          // Same rule as the fields above, and here it is the one that bites:
          // an absent `photos` field is indistinguishable from a partial 200,
          // so an empty answer is "no news" and must leave the stored refs
          // alone. Writing it through would blank the venue on the board until
          // its next scan — nine days for a full Kyiv cycle, against the five
          // minutes the old in-process cache held an empty answer for.
          ...(details.photoRefs.length > 0
            ? { photoRefs: details.photoRefs.slice(0, CURATED_PHOTO_REFS_MAX) }
            : {}),
          lastVerifiedAt: new Date(),
        },
      });
      refreshed++;
    }
  }

  return { scanned: rows.length, deactivated, refreshed, failed };
}
