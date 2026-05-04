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
export async function getOrCompute<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const cacheKey = `${CACHE_KEY_PREFIX}${key}`;

  const row = await prisma.systemKnowledge.findUnique({
    where: { key: cacheKey },
  });

  if (row && row.active) {
    const ageSec = (Date.now() - row.updatedAt.getTime()) / 1000;
    if (ageSec < ttlSeconds) {
      try {
        return JSON.parse(row.content) as T;
      } catch {
        // fall through to recompute
      }
    }
  }

  const value = await compute();
  const serialized = JSON.stringify(value);

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
