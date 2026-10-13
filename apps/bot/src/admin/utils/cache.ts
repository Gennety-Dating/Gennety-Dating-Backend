import { prisma } from "@gennety/db";
import { BoundedMap } from "../../utils/bounded-map.js";
import { adminQuery } from "./db-gate.js";
import { createSingleFlight } from "./single-flight.js";

/**
 * The two markers that identify a row as analytics cache rather than operator
 * knowledge. Exported because `services/prompt-builder.ts` filters on BOTH of
 * them — a duplicated literal there is exactly what let this namespace leak.
 */
export const ADMIN_CACHE_KEY_PREFIX = "admin_cache:";
export const ADMIN_CACHE_CATEGORY = "admin_cache";

const CACHE_KEY_PREFIX = ADMIN_CACHE_KEY_PREFIX;

/**
 * SystemKnowledge-backed JSON cache for heavy analytics queries.
 *
 * Reuses the existing `system_knowledge` table (already in the schema)
 * instead of pulling in Redis.
 *
 * **These rows must never reach the menu agent's prompt.** They are not
 * knowledge — they are internal analytics (user counts, gender funnel, city
 * centroids, growth) — and the isolation is enforced by ONE place:
 * `fetchKnowledgeBase` in `services/prompt-builder.ts`, which excludes both
 * `ADMIN_CACHE_CATEGORY` and `ADMIN_CACHE_KEY_PREFIX`. This comment used to
 * claim the namespaces "never collide" on their own; they did, for months —
 * that query had no category filter at all, so ~23k characters of analytics
 * rode into every single agent turn.
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

/**
 * The `system_knowledge` row as this process last wrote or read it.
 *
 * An in-process copy that answers exactly what the database would: the same
 * `content` and the same `updatedAt`, so a hit is decided by the same
 * `ttlSeconds` against the same stored timestamp — the expiry is mirrored,
 * never extended. It only ever short-circuits a HIT; an expired or missing
 * copy goes to the database exactly as before.
 *
 * Exact because these rows have one writer: this module, in the single bot
 * process (the demo runs against its own database and has no admin API; the
 * knowledge seed writes other keys). While a write for a key is in flight the
 * copy is dropped and the database answers, and when two writes, or a read and
 * a write, overlap, the copy is not refilled — the database answers until the
 * next clean write.
 */
interface MirroredRow {
  content: string;
  updatedAt: Date;
}

/** Bounded by the number of distinct cache keys, which the code fixes. */
const MIRROR_MAX_KEYS = 256;
const mirror = new BoundedMap<string, MirroredRow>(MIRROR_MAX_KEYS);
/** Writes (`upsert`, `invalidate`) in flight per key. */
const pendingWrites = new Map<string, number>();
/** Keys with overlapping writes — which one landed last is not knowable here. */
const contended = new Set<string>();
/** Moves at every write's start and end, so a read that overlapped one is not mirrored. */
const writeVersion = new Map<string, number>();

function bumpVersion(cacheKey: string): void {
  writeVersion.set(cacheKey, (writeVersion.get(cacheKey) ?? 0) + 1);
}

function beginWrite(cacheKey: string): void {
  mirror.delete(cacheKey);
  bumpVersion(cacheKey);
  const pending = (pendingWrites.get(cacheKey) ?? 0) + 1;
  pendingWrites.set(cacheKey, pending);
  if (pending > 1) contended.add(cacheKey);
}

/** `stored` is the row the write left behind, or null when unknown or deactivated. */
function endWrite(cacheKey: string, stored: MirroredRow | null): void {
  bumpVersion(cacheKey);
  const pending = (pendingWrites.get(cacheKey) ?? 1) - 1;
  if (stored && !contended.has(cacheKey)) mirror.set(cacheKey, stored);
  else mirror.delete(cacheKey);
  if (pending > 0) {
    pendingWrites.set(cacheKey, pending);
  } else {
    pendingWrites.delete(cacheKey);
    contended.delete(cacheKey);
  }
}

/** The stored row for `cacheKey`: the mirror when it holds a hit, else the database. */
async function readRow(
  cacheKey: string,
  ttlSeconds: number,
): Promise<{ content: string; updatedAt: Date; active: boolean } | null> {
  const mirrored = pendingWrites.has(cacheKey) ? undefined : mirror.get(cacheKey);
  if (mirrored && (Date.now() - mirrored.updatedAt.getTime()) / 1000 < ttlSeconds) {
    return { ...mirrored, active: true };
  }

  const versionAtStart = writeVersion.get(cacheKey) ?? 0;
  const row = await adminQuery(() =>
    prisma.systemKnowledge.findUnique({ where: { key: cacheKey } }),
  );
  if (
    row &&
    row.active &&
    !pendingWrites.has(cacheKey) &&
    (writeVersion.get(cacheKey) ?? 0) === versionAtStart
  ) {
    mirror.set(cacheKey, { content: row.content, updatedAt: row.updatedAt });
  }
  return row;
}

async function writeRow(cacheKey: string, key: string, serialized: string): Promise<void> {
  beginWrite(cacheKey);
  let stored: MirroredRow | null = null;
  try {
    const written = await adminQuery(() =>
      prisma.systemKnowledge.upsert({
        where: { key: cacheKey },
        create: {
          key: cacheKey,
          title: `Admin analytics cache: ${key}`,
          content: serialized,
          category: ADMIN_CACHE_CATEGORY,
        },
        update: { content: serialized, active: true },
        select: { updatedAt: true },
      }),
    );
    // The stored timestamp, not a local clock: the mirror's TTL has to run
    // from exactly the instant the database's does.
    if (written.updatedAt instanceof Date) {
      stored = { content: serialized, updatedAt: written.updatedAt };
    }
  } finally {
    endWrite(cacheKey, stored);
  }
}

/**
 * What one lookup produced. Each caller turns it into its own value, so no two
 * requests ever hold the same object.
 */
type Lookup<T> =
  | { kind: "hit"; content: string; parsed: T; generatedAt: Date }
  | {
      kind: "computed";
      value: T;
      serialized: string;
      generatedAt: Date;
      /** The upsert failed after the value was computed — rethrown per caller. */
      writeError?: { error: unknown };
    };

/**
 * Concurrent misses for one key used to compute the same analytics N times —
 * N copies of the heaviest queries in the admin, in parallel, on the shared
 * pool. Non-`fresh` callers asking for the same key and TTL now share the one
 * lookup already in flight (read, then compute and write on a miss).
 * `?fresh=1` never joins one and is never joined: a Refresh tap computes after
 * it was asked.
 */
const lookups = createSingleFlight<string, Lookup<unknown>>();

async function computeAndStore<T>(
  cacheKey: string,
  key: string,
  compute: () => Promise<T>,
): Promise<Lookup<T>> {
  const value = await compute();
  const serialized = JSON.stringify(value);
  const generatedAt = new Date();
  try {
    await writeRow(cacheKey, key, serialized);
  } catch (error) {
    return { kind: "computed", value, serialized, generatedAt, writeError: { error } };
  }
  return { kind: "computed", value, serialized, generatedAt };
}

async function lookup<T>(
  cacheKey: string,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<Lookup<T>> {
  const row = await readRow(cacheKey, ttlSeconds);
  if (row && row.active) {
    const ageSec = (Date.now() - row.updatedAt.getTime()) / 1000;
    if (ageSec < ttlSeconds) {
      try {
        const parsed = JSON.parse(row.content) as T;
        return { kind: "hit", content: row.content, parsed, generatedAt: row.updatedAt };
      } catch {
        // fall through to recompute
      }
    }
  }
  return computeAndStore(cacheKey, key, compute);
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

  let outcome: Lookup<T>;
  let joined = false;
  if (wantsFresh(ctx)) {
    outcome = await computeAndStore(cacheKey, key, compute);
  } else {
    const flight = lookups.join(`${cacheKey}|${ttlSeconds}`, () =>
      lookup(cacheKey, key, ttlSeconds, compute),
    );
    joined = flight.joined;
    outcome = (await flight.result) as Lookup<T>;
  }

  if (outcome.kind === "hit") {
    stamp(outcome.generatedAt, true);
    return joined ? (JSON.parse(outcome.content) as T) : outcome.parsed;
  }
  stamp(outcome.generatedAt, false);
  if (outcome.writeError) throw outcome.writeError.error;
  // The caller that computed keeps its own value, exactly as before; one that
  // joined gets the stored form, which is what a cache hit would have handed it.
  return joined ? (JSON.parse(outcome.serialized) as T) : outcome.value;
}

/**
 * Force-invalidate a cached entry. Useful for admin actions that mutate
 * data which a cached endpoint depends on (rarely needed — TTL is enough
 * for read-mostly analytics).
 */
export async function invalidate(key: string): Promise<void> {
  const cacheKey = `${CACHE_KEY_PREFIX}${key}`;
  beginWrite(cacheKey);
  try {
    await adminQuery(() =>
      prisma.systemKnowledge.update({ where: { key: cacheKey }, data: { active: false } }),
    ).catch(() => {
      // row didn't exist — nothing to invalidate
    });
  } finally {
    endWrite(cacheKey, null);
  }
}

/** Empties the in-process mirror, so a test's next read goes to its fake database. */
export function __resetAdminCacheMirrorForTests(): void {
  mirror.clear();
  pendingWrites.clear();
  contended.clear();
  writeVersion.clear();
}
