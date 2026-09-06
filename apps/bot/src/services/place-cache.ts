import { prisma } from "@gennety/db";

/**
 * The Google Places cache (`place_cache`).
 *
 * One row per `place_id`, holding the *static* facts about a place — name,
 * address, coordinates, photo resource names. It exists because those facts do
 * not change and were being re-bought anyway: the Mini App's departure picker
 * resolves the same handful of metro stations and campus buildings for every
 * user in a city, and before this each resolution was its own Place Details
 * request. The only cache that existed lived in process memory
 * (`services/venue-change.ts` → `photoCache`) and went cold on every deploy.
 *
 * ## Terms of Service, which is what shapes the schema
 *
 * `place_id` may be stored indefinitely, so it is the primary key. Everything
 * else is provider content and is capped at {@link PLACE_CACHE_TTL_MS} — 30
 * days, Google's ceiling. A row past its TTL is a MISS, not a stale hit: the
 * caller re-fetches and overwrites. {@link prunePlaceCache} then deletes what
 * expired, so the table neither grows without bound nor holds content longer
 * than permitted, even for a place nobody asks about again.
 *
 * Photo **bytes** are deliberately absent and must stay absent — caching the
 * images is not permitted, which is why `date-card/photo-source.ts` streams
 * them at render time and keeps nothing. This table stores the pointers only.
 *
 * ## Failure policy
 *
 * Every function here is best-effort and never throws. A cache is an
 * optimisation; a database hiccup must degrade to "call Google" rather than
 * fail a date. That is also why writes are fire-and-forget from the caller's
 * point of view — a failed write costs one future request, nothing else.
 */

/**
 * How long provider content may be reused. 30 days is the ToS ceiling, and the
 * default is right at it because the facts this row exists for do not age: a
 * café's coordinates and street address are the same in a month.
 *
 * **A photo resource name is the exception**, and callers reading one must pass
 * their own shorter `ttlMs` — see `PHOTO_CACHE_TTL_MS` in
 * `services/venue-change.ts`. Names rotate, a stale one 404s, and the tile then
 * shows a category glyph, so trusting one for a month would trade a re-bought
 * lookup for a picture-less card. Never raise this past 30 days.
 */
export const PLACE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The static facts we cache. Mirrors the columns, minus the bookkeeping. */
export interface CachedPlace {
  placeId: string;
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  /**
   * Photo resource names, cover first. May be EMPTY, which means "the answer we
   * cached carried no photos" — indistinguishable from a partial 200, so a
   * caller must not treat it as "this place has no pictures".
   */
  photoRefs: string[];
  /**
   * When the provider content was last written. Exposed because the fields in
   * this row do not all age at the same rate: coordinates and an address are
   * permanent, while a photo resource name ROTATES and a stale one 404s. A
   * caller that only wants the photos therefore reads with its own, shorter
   * `ttlMs` and can size its own downstream cache from what is left of it.
   */
  refreshedAt: Date;
}

/** Fields a caller may write. `placeId` addresses the row; the rest is content. */
export type PlaceCacheWrite = Partial<Omit<CachedPlace, "placeId" | "refreshedAt">>;

function isFresh(refreshedAt: Date, ttlMs: number, now: number): boolean {
  return now - refreshedAt.getTime() < ttlMs;
}

/**
 * Read one place, or `null` on a miss — which includes an expired row.
 *
 * An expired row is left in place rather than deleted here: the caller is about
 * to overwrite it, and deleting first would turn one round trip into two. The
 * pruner is what removes rows nobody comes back for.
 */
export async function readPlaceCache(
  placeId: string,
  options: { ttlMs?: number; now?: number } = {},
): Promise<CachedPlace | null> {
  const ttlMs = options.ttlMs ?? PLACE_CACHE_TTL_MS;
  const now = options.now ?? Date.now();
  try {
    const row = await prisma.placeCache.findUnique({ where: { placeId } });
    if (!row || !isFresh(row.refreshedAt, ttlMs, now)) return null;
    return {
      placeId: row.placeId,
      name: row.name,
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      photoRefs: row.photoRefs,
      refreshedAt: row.refreshedAt,
    };
  } catch (err) {
    console.warn(`[place-cache] read failed for ${placeId}:`, err);
    return null;
  }
}

/**
 * Read many places in one round trip. Missing and expired ids are simply absent
 * from the returned map, so a caller iterates its own id list and treats an
 * absent key as a miss.
 *
 * Exists because the venue-change board resolves photos for up to 21 places at
 * once: twenty-one `findUnique` calls to decide which ones still need Google is
 * a worse trade than the single `IN` query they collapse into.
 */
export async function readPlaceCacheMany(
  placeIds: string[],
  options: { ttlMs?: number; now?: number } = {},
): Promise<Map<string, CachedPlace>> {
  const out = new Map<string, CachedPlace>();
  if (placeIds.length === 0) return out;
  const ttlMs = options.ttlMs ?? PLACE_CACHE_TTL_MS;
  const now = options.now ?? Date.now();
  try {
    const rows = await prisma.placeCache.findMany({
      where: { placeId: { in: [...new Set(placeIds)] } },
    });
    for (const row of rows) {
      if (!isFresh(row.refreshedAt, ttlMs, now)) continue;
      out.set(row.placeId, {
        placeId: row.placeId,
        name: row.name,
        address: row.address,
        lat: row.lat,
        lng: row.lng,
        photoRefs: row.photoRefs,
        refreshedAt: row.refreshedAt,
      });
    }
  } catch (err) {
    console.warn("[place-cache] batch read failed:", err);
  }
  return out;
}

/**
 * Write (or refresh) one place. Only the fields present in `data` are touched,
 * so a photo lookup cannot blank the coordinates a resolve call stored, and a
 * resolve cannot blank the photo refs.
 *
 * `refreshedAt` is always stamped, including on a partial write — which is the
 * intended reading of the TTL: it dates the last time we heard from the
 * provider about this place at all.
 */
export async function writePlaceCache(
  placeId: string,
  data: PlaceCacheWrite,
  options: { now?: Date } = {},
): Promise<void> {
  const refreshedAt = options.now ?? new Date();
  // Drop `undefined` keys so `update` leaves those columns alone rather than
  // Prisma treating the key as "no change" only by accident.
  const content = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as PlaceCacheWrite;
  try {
    await prisma.placeCache.upsert({
      where: { placeId },
      create: { placeId, ...content, refreshedAt },
      update: { ...content, refreshedAt },
    });
  } catch (err) {
    console.warn(`[place-cache] write failed for ${placeId}:`, err);
  }
}

/**
 * Delete every row whose content has expired. Returns the count.
 *
 * Called from the nightly re-validation cron, which is already the job that
 * owns "keep provider data honest". Batched by nothing — the table holds one
 * row per distinct place a user has ever picked, which is thousands, not
 * millions.
 */
export async function prunePlaceCache(
  options: { ttlMs?: number; now?: number } = {},
): Promise<number> {
  const ttlMs = options.ttlMs ?? PLACE_CACHE_TTL_MS;
  const now = options.now ?? Date.now();
  try {
    const { count } = await prisma.placeCache.deleteMany({
      where: { refreshedAt: { lt: new Date(now - ttlMs) } },
    });
    return count;
  } catch (err) {
    console.warn("[place-cache] prune failed:", err);
    return 0;
  }
}
