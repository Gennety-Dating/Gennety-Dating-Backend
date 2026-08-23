import { Prisma, prisma } from "@gennety/db";
import { SUPPORTED_CITY_KEYS } from "@gennety/shared";
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
 * periodically re-checks the stalest active venues **in launched markets**
 * against Google Places (Place Details, by stored `placeId`):
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
 * **The batch is `batchSize` distinct PLACES, not rows** (fixed 2026-08-23 —
 * DECISIONS.md). The seeder writes one row per `universityDomain`, so a single
 * real venue is stored ~5×, and this cron used to spend one Place Details
 * request on each copy and stamp only that copy. Combined with having no market
 * filter, it walked 1712 rows — 434 of them in Kharkiv/Odesa, which are not
 * launched markets and cannot hold a user — so a full pass took 57 nights
 * instead of the ~9 both ARCHITECTURE.md and PRODUCT_SPEC.md have always
 * claimed. The visible cost was that `photoRefs` reached **0 of 275 Kyiv
 * places** while landing on 90 rows in cities nobody can match in, i.e. the
 * whole point of folding `photos` into this request delivered nothing to the
 * only market that exists. One request now refreshes every copy of a place
 * (`updateMany` on `placeId`), and only launched markets are scanned.
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

/**
 * Cap on ROWS pulled to compute the batch of distinct places.
 *
 * The window is the N stalest rows in launched markets, so for any place with a
 * row inside it, that place's *stalest* row is inside it too — which is what
 * makes the min computed from the window equal the true min for every place the
 * window sees. At ~5 copies per place, 5000 rows always yields ≥1000 distinct
 * places, 33× the default batch. Today it never truncates (Kyiv is 1278 rows);
 * it exists so memory stays bounded if the catalog grows an order of magnitude.
 */
export const VENUE_REVALIDATION_SCAN_WINDOW_ROWS = 5000;

/** One real venue, collapsed from its per-`universityDomain` copies. */
export interface RevalidationTarget {
  placeId: string;
  /** Name from the copy owning the min; copies are identical in practice. */
  name: string;
}

/**
 * Row shape {@link selectStalestPlaces} needs. Deliberately structural and with
 * `lastVerifiedAt` optional, so a caller (or a test fixture) that has not
 * selected the column still type-checks — an absent value reads as "never
 * verified", which is the safe direction: it sorts first and gets scanned.
 */
export interface RevalidationCandidateRow {
  placeId: string | null;
  name: string;
  lastVerifiedAt?: Date | null;
}

/** Sort key: never-verified must beat every real date. */
function stalenessKey(at: Date | null | undefined): number {
  return at == null ? Number.NEGATIVE_INFINITY : at.getTime();
}

/**
 * Collapse duplicate rows to one target per `placeId`, stalest first.
 *
 * Exported because this IS the fix and it is pure — testing it needs no Prisma
 * mock at all. Three rules inside are load-bearing:
 *
 * 1. A place is represented by its **oldest** copy, not its newest. With the
 *    newest, a copy that lagged behind its siblings would look fresh forever
 *    and never be revisited.
 * 2. A missing `lastVerifiedAt` sorts FIRST. This is why the obvious
 *    `groupBy({ by: ["placeId"], _min: … })` had to be rejected: Prisma types
 *    aggregate `orderBy` as a bare `SortOrder` with no `nulls` knob, and
 *    Postgres defaults `ORDER BY min(...) ASC` to NULLS LAST — so the
 *    never-verified places this cron exists to reach would queue dead last,
 *    permanently and silently.
 * 3. The `placeId` tie-break is not cosmetic. Copies routinely share an exact
 *    `lastVerifiedAt` (they are stamped together), so without it the batch is
 *    whatever order Postgres returned: not reproducible, and not assertable in
 *    a test. With it the walk converges monotonically — tonight's 30 carry a
 *    fresh date and sort last tomorrow.
 */
export function selectStalestPlaces(
  rows: readonly RevalidationCandidateRow[],
  limit: number,
): RevalidationTarget[] {
  if (limit <= 0) return [];

  const stalest = new Map<string, { name: string; key: number }>();
  for (const row of rows) {
    if (row.placeId == null) continue;
    const key = stalenessKey(row.lastVerifiedAt);
    const seen = stalest.get(row.placeId);
    if (seen === undefined || key < seen.key) {
      stalest.set(row.placeId, { name: row.name, key });
    }
  }

  return [...stalest.entries()]
    .sort(([aId, a], [bId, b]) => {
      // NOT `a.key - b.key`: two never-verified places are both -Infinity, and
      // `-Infinity - -Infinity` is NaN. Comparing for inequality first avoids
      // float arithmetic entirely.
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    })
    .slice(0, limit)
    .map(([placeId, { name }]) => ({ placeId, name }));
}

/**
 * `options.batchSize` › `VENUE_REVALIDATION_BATCH_SIZE` › the compiled default.
 *
 * Validated explicitly rather than via the repo's usual
 * `Number(process.env.X ?? "30")` idiom, and that is not defensive padding: it
 * preserves a LOUD failure. Under the old row-based code a garbage value became
 * `take: NaN`, which Prisma rejects, so `guardedTick` logged it. Under the new
 * code the same garbage would reach `.slice(0, NaN)` → `[]` → a cron that
 * silently scans nothing, every night, forever.
 */
function resolveBatchSize(override: number | undefined): number {
  if (override != null && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = process.env.VENUE_REVALIDATION_BATCH_SIZE;
  if (raw != null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    console.warn(
      `[venue-revalidation] ignoring invalid VENUE_REVALIDATION_BATCH_SIZE=${raw}`,
    );
  }
  return DEFAULT_VENUE_REVALIDATION_BATCH;
}

export interface VenueRevalidationOptions {
  /**
   * Cap **distinct places** touched per tick — i.e. Places requests. Default 30.
   * Overridable at runtime with `VENUE_REVALIDATION_BATCH_SIZE`.
   */
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
  const batchSize = resolveBatchSize(options.batchSize);
  const apiKey = options.apiKey ?? process.env.PLACES_API_KEY ?? "";
  const fetchDetails = options.fetchDetails ?? fetchPlaceDetails;

  // Without a key (local dev) there's nothing to validate against.
  if (!apiKey) return { scanned: 0, deactivated: 0, refreshed: 0, failed: 0 };

  // Launched markets only. A row in an unlaunched city cannot hold a match
  // (§3.2 filter 5 joins on an exact `homeCityKey`), so re-checking it buys
  // nothing and spends the same top-tier request a Kyiv venue would. Read from
  // SUPPORTED_CITY_KEYS rather than naming Kyiv, so launching a market picks
  // itself up. Verified before shipping: prod has zero active rows with a
  // `placeId` and a NULL `cityKey`, so this orphans nobody — if that ever stops
  // being true, backfill `city_key` rather than widening this filter, because
  // such a row stays user-visible via the `universityDomain` lookup.
  const rows = await prisma.curatedVenue.findMany({
    where: {
      active: true,
      placeId: { not: null },
      cityKey: { in: [...SUPPORTED_CITY_KEYS] },
    },
    orderBy: { lastVerifiedAt: { sort: "asc", nulls: "first" } },
    take: VENUE_REVALIDATION_SCAN_WINDOW_ROWS,
    select: { placeId: true, name: true, lastVerifiedAt: true },
  });

  const targets = selectStalestPlaces(rows, batchSize);

  let deactivated = 0;
  let refreshed = 0;
  let failed = 0;

  for (const target of targets) {
    let details: PlaceDetails;
    try {
      details = await fetchDetails(apiKey, target.placeId);
    } catch (err) {
      // Infra failure — do NOT deactivate. Retry next tick.
      failed++;
      console.warn(
        `[venue-revalidation] details fetch failed for ${target.name} (${target.placeId}):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    // Every write below keys on `placeId`, not on a row id, so one request
    // settles all ~5 domain copies at once and they stop returning to the queue
    // one at a time. Deliberately NOT scoped to launched markets: it is the same
    // physical venue, so a closure is a closure in every copy.
    //
    // `place_id` is not indexed (`curated_venues` has only the
    // `[universityDomain, category, active]` and `[cityKey, tier, active]`
    // indexes), so each of these seq-scans the table. At ~2k rows × 30 writes a
    // night that is sub-millisecond against the HTTP call in front of it, and an
    // index would turn a code deploy into a schema deploy — a deliberate,
    // reversible omission. Revisit around ~10^5 rows.
    if (isNowUnfit(details)) {
      const { count } = await prisma.curatedVenue.updateMany({
        where: { placeId: target.placeId },
        data: { active: false, lastVerifiedAt: new Date() },
      });
      deactivated++;
      console.log(
        `[venue-revalidation] deactivated "${target.name}" (status=${details.businessStatus} rating=${details.rating} reviews=${details.userRatingCount} rows=${count})`,
      );
    } else {
      await prisma.curatedVenue.updateMany({
        where: { placeId: target.placeId },
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
          // Always a no-op since 2026-08-23: `editorialSummary` was dropped from
          // PLACE_DETAILS_FIELD_MASK (it alone set this request's billing tier),
          // so it arrives null and the "absent means no news" rule leaves the
          // seeded value in place. Kept rather than deleted because it is the
          // same rule as its neighbours, and re-adding the field to the mask
          // must not also require re-adding the write.
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

  // Counters are PLACES, not rows — so `scanned` is exactly the night's Places
  // request count, and `scanned === deactivated + refreshed + failed` still
  // holds (counting rows would make `deactivated` ~5× while `failed` stayed 1×).
  // Ops consequence worth knowing: the log line in `index.ts` keeps its shape
  // but changes units, so `scanned=30` now means 30 venues / ~150 rows.
  return { scanned: targets.length, deactivated, refreshed, failed };
}
