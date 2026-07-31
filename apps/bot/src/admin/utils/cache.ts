import { prisma } from "@gennety/db";

const CACHE_KEY_PREFIX = "admin_cache:";

/**
 * SystemKnowledge-backed JSON cache for heavy analytics queries.
 *
 * Reuses the existing `system_knowledge` table (already in the schema)
 * instead of pulling in Redis. Rows under the `admin_cache` category are
 * never read by the bot's runtime knowledge lookups — the prefix on the
 * key + the dedicated category keep the two namespaces from colliding.
 *
 * Returns the cached value if its `updatedAt` is younger than `ttlSeconds`,
 * otherwise recomputes via `compute()` and writes the new value.
 *
 * If JSON parsing of a cached row fails (schema drift, partial write), the
 * cache miss is treated like a stale entry — recompute and overwrite.
 */
/**
 * Request/response pair a cached route can hand in.
 *
 * Two things the cache knows and the caller cannot: whether the operator asked
 * for a forced recompute (`?fresh=1`), and how old the numbers on screen
 * actually are. Both are reported here rather than reimplemented per route, so
 * every cached endpoint answers them the same way.
 *
 * Structurally typed rather than importing Express, so the helper stays
 * testable without spinning up a request.
 */
export interface CacheContext {
  req?: { query?: Record<string, unknown> } | undefined;
  res?: { setHeader(name: string, value: string): void } | undefined;
}

/** `?fresh=1` — the dashboard's Refresh button. */
export function wantsFresh(ctx: CacheContext | undefined): boolean {
  return String(ctx?.req?.query?.["fresh"] ?? "") === "1";
}

export async function getOrCompute<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
  ctx?: CacheContext,
): Promise<T> {
  const cacheKey = `${CACHE_KEY_PREFIX}${key}`;

  const stamp = (generatedAt: Date, hit: boolean): void => {
    ctx?.res?.setHeader("X-Data-Generated-At", generatedAt.toISOString());
    ctx?.res?.setHeader("X-Data-Cache", hit ? "hit" : "miss");
  };

  const row = wantsFresh(ctx)
    ? null
    : await prisma.systemKnowledge.findUnique({ where: { key: cacheKey } });

  if (row && row.active) {
    const ageSec = (Date.now() - row.updatedAt.getTime()) / 1000;
    if (ageSec < ttlSeconds) {
      try {
        const parsed = JSON.parse(row.content) as T;
        stamp(row.updatedAt, true);
        return parsed;
      } catch {
        // fall through to recompute
      }
    }
  }

  const value = await compute();
  const serialized = JSON.stringify(value);
  stamp(new Date(), false);

  await prisma.systemKnowledge.upsert({
    where: { key: cacheKey },
    create: {
      key: cacheKey,
      title: `Admin analytics cache: ${key}`,
      content: serialized,
      category: "admin_cache",
    },
    update: { content: serialized, active: true },
  });

  return value;
}

/**
 * Force-invalidate a cached entry. Useful for admin actions that mutate
 * data which a cached endpoint depends on (rarely needed — TTL is enough
 * for read-mostly analytics).
 */
export async function invalidate(key: string): Promise<void> {
  const cacheKey = `${CACHE_KEY_PREFIX}${key}`;
  await prisma.systemKnowledge
    .update({ where: { key: cacheKey }, data: { active: false } })
    .catch(() => {
      // row didn't exist — nothing to invalidate
    });
}
