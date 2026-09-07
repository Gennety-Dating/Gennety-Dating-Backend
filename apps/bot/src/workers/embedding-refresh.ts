import { prisma } from "@gennety/db";
import { env } from "../config.js";
import {
  buildEmbeddingInput,
  createOpenAIEmbeddingClient,
  toPgVectorLiteral,
  type EmbeddingClient,
  type ParsedProfileSummary,
} from "../services/profile-analysis.js";

/**
 * M-2: background worker that recomputes embeddings for profiles whose
 * embedding-feeding fields (psychologicalSummary, partnerPreferences,
 * negativeConstraints, hobbies) have changed since the last refresh.
 *
 * Triggering writes set `Profile.embeddingDirty = true`. This worker:
 *   1. Picks up dirty rows (oldest dirtyAt first, capped per tick).
 *   2. Composes a fresh embedding input from the current profile state.
 *   3. Calls the OpenAI embeddings endpoint.
 *   4. Writes the new vector + clears the dirty flag in one conditional SQL
 *      statement so a concurrent dirty-bump after generation is not clobbered.
 *
 * The "concurrent re-dirty" guard works like this: we capture
 * `embeddingDirtyAt` at the start of the tick. The clear-flag write only
 * succeeds if `embeddingDirtyAt` still matches — if the user edited again
 * mid-flight, `embeddingDirtyAt` advanced and the clear is a no-op, so the
 * next tick will re-pick the row and recompute against the latest input.
 */

export const DEFAULT_EMBEDDING_REFRESH_BATCH = 20;
export const DEFAULT_EMBEDDING_REFRESH_TIMEOUT_MS = 30_000;
/** Bound upstream work while keeping weekly preflight independent of cron's
 * 20-row page size. Four requests avoids an hours-long serial backlog without
 * creating an OpenAI rate-limit stampede. */
export const DEFAULT_EMBEDDING_REFRESH_CONCURRENCY = 4;
/**
 * Inputs per Embeddings request.
 *
 * The API accepts up to 2048; this stays well under so one failed request
 * costs a couple of hundred profiles rather than a couple of thousand — they
 * stay dirty and the next pass retries them, but the smaller the blast radius
 * the sooner the drop has what it needs.
 */
export const EMBEDDING_INPUTS_PER_REQUEST = 256;
/**
 * Rows the weekly preflight will take in one pass, and how many passes it may
 * make before it stops and says the snapshot is incomplete.
 *
 * It used to pass no `take` at all — every dirty profile in the database in one
 * `findMany`, ordered by a column no index led with. The cap makes the read
 * bounded; the loop keeps the preflight's actual promise, which is to leave
 * nothing dirty behind before matching runs.
 */
export const AGGREGATE_REFRESH_PAGE = 512;
export const AGGREGATE_REFRESH_MAX_PAGES = 40;

export interface EmbeddingRefreshOptions {
  /** Cap rows touched per tick. Default 20 — balances OpenAI cost vs. lag. */
  batchSize?: number;
  /** Test injection: override the OpenAI embedding client. */
  client?: EmbeddingClient;
  /** Optional per-row deadline. Timeout leaves the row dirty for a retry. */
  timeoutMs?: number;
  /** Maximum simultaneous embedding requests. */
  concurrency?: number;
}

export interface EmbeddingRefreshResult {
  scanned: number;
  refreshed: number;
  failed: number;
  /** Scanned rows that remain dirty after this attempt (failures + CAS races). */
  stillDirty: number;
}

interface RefreshSelection {
  batchSize?: number;
  userId?: string;
  /** Weekly preflight emits only its aggregate summary from match-engine. */
  aggregateOnly?: boolean;
}

/**
 * One refresh tick. Returns counts for logging. Never throws — a failed
 * row is logged + left dirty for the next tick.
 */
export async function embeddingRefreshTick(
  options: EmbeddingRefreshOptions = {},
): Promise<EmbeddingRefreshResult> {
  return refreshDirtyEmbeddings(
    { batchSize: options.batchSize ?? DEFAULT_EMBEDDING_REFRESH_BATCH },
    options,
  );
}

/** Refresh one profile immediately after an embedding-feeding edit. */
export async function refreshUserEmbedding(
  userId: string,
  options: EmbeddingRefreshOptions = {},
): Promise<EmbeddingRefreshResult> {
  return refreshDirtyEmbeddings(
    { userId },
    { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_EMBEDDING_REFRESH_TIMEOUT_MS },
  );
}

/**
 * Refresh the complete dirty snapshot before weekly matching. Rows dirtied
 * after the snapshot are intentionally left for the next worker/preflight.
 *
 * "Complete" is now reached by paging rather than by one unbounded read: a
 * `findMany` over every dirty profile at once is a sequential scan whose result
 * set is also held whole in memory, on a droplet with 2 GB and one core. The
 * loop stops as soon as a page comes back short — that is the snapshot being
 * exhausted — and the page cap is a floor under the worst case, logged loudly
 * because a preflight that gives up early is a matching run with stale vectors.
 */
export async function refreshAllDirtyEmbeddings(
  options: Omit<EmbeddingRefreshOptions, "batchSize"> = {},
): Promise<EmbeddingRefreshResult> {
  const shared = {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_EMBEDDING_REFRESH_TIMEOUT_MS,
  };
  const total: EmbeddingRefreshResult = {
    scanned: 0,
    refreshed: 0,
    failed: 0,
    stillDirty: 0,
  };

  for (let page = 0; page < AGGREGATE_REFRESH_MAX_PAGES; page += 1) {
    const result = await refreshDirtyEmbeddings(
      { aggregateOnly: true, batchSize: AGGREGATE_REFRESH_PAGE },
      shared,
    );
    total.scanned += result.scanned;
    total.refreshed += result.refreshed;
    total.failed += result.failed;
    total.stillDirty += result.stillDirty;
    // A short page means the dirty set is exhausted. A page that refreshed
    // NOTHING also ends it: every row in it either failed or lost the re-dirty
    // race, and asking again would return the same rows forever.
    if (result.scanned < AGGREGATE_REFRESH_PAGE || result.refreshed === 0) return total;
  }

  console.warn(
    `[embedding-refresh] preflight stopped at the ${AGGREGATE_REFRESH_MAX_PAGES}-page cap ` +
      `after ${total.refreshed} refreshed — dirty profiles remain and matching will use stale vectors for them`,
  );
  return total;
}

async function refreshDirtyEmbeddings(
  selection: RefreshSelection,
  options: EmbeddingRefreshOptions,
): Promise<EmbeddingRefreshResult> {
  const client =
    options.client ??
    (env.OPENAI_API_KEY ? createOpenAIEmbeddingClient(env.OPENAI_API_KEY) : null);

  const dirty = await prisma.profile.findMany({
    where: {
      embeddingDirty: true,
      ...(selection.userId ? { userId: selection.userId } : {}),
    },
    orderBy: { embeddingDirtyAt: "asc" },
    ...(selection.batchSize === undefined ? {} : { take: selection.batchSize }),
    select: {
      id: true,
      userId: true,
      psychologicalSummary: true,
      partnerPreferences: true,
      negativeConstraints: true,
      hobbies: true,
      embeddingDirtyAt: true,
      // The voice prompt's transcript is an embedding input that deliberately
      // does NOT live in `psychologicalSummary` — see the append below.
      user: { select: { voicePrompt: { select: { transcript: true } } } },
    },
  });

  // A missing/misconfigured client is a refresh failure, not a successful
  // no-op. Report the dirty rows accurately so Telegram can tell the user
  // that automatic synchronization is still pending and matching stays closed.
  if (!client) {
    return {
      scanned: dirty.length,
      refreshed: 0,
      failed: dirty.length,
      stillDirty: dirty.length,
    };
  }

  type Row = (typeof dirty)[number];

  /**
   * The text one profile is embedded from.
   *
   * `partnerPreferences` and `negativeConstraints` are appended here because
   * `buildEmbeddingInput` only knows the structured `ParsedProfileSummary`, and
   * the voice transcript is read from its own column rather than folded into
   * `psychologicalSummary`: that field is replaced wholesale by the About-me
   * editor, so folding it in would silently wipe the voice on every bio edit —
   * and unlike the vibe answers a transcript CHANGES on every re-record, so
   * `appendVibeToSummary`'s `includes()` idempotency would append rather than
   * replace, tripling the voice's weight after three re-records. Composed at
   * refresh time, the weight is constant by construction.
   */
  const composeInput = (row: Row): string => {
    const baseSummary: ParsedProfileSummary = {};
    if (row.psychologicalSummary) baseSummary.summary = row.psychologicalSummary;
    if (row.hobbies.length) baseSummary.interests = row.hobbies;
    let text = buildEmbeddingInput(baseSummary, row.psychologicalSummary ?? "");
    if (row.partnerPreferences) {
      text += `\nPartner preferences: ${row.partnerPreferences}`;
    }
    if (row.negativeConstraints) {
      text += `\nDealbreakers: ${row.negativeConstraints}`;
    }
    const transcript = row.user?.voicePrompt?.transcript;
    if (transcript) {
      text += `\nVoice prompt: ${transcript}`;
    }
    return text.slice(0, 8000);
  };

  /**
   * Write one vector, but only if the row still says what it said when we read
   * it. If the user edited again while the request was in flight,
   * `embeddingDirtyAt` advanced and this is a no-op — the next pass recomputes
   * against the newer input rather than clobbering it with the older one.
   */
  const persist = async (row: Row, vec: number[]): Promise<"refreshed" | "stale"> => {
    const literal = toPgVectorLiteral(vec);
    const updated = await prisma.$executeRaw`
      UPDATE profiles
         SET embedding = ${literal}::vector,
             embedding_dirty = false,
             embedding_dirty_at = NULL
       WHERE id = ${row.id}::uuid
         AND embedding_dirty = true
         AND embedding_dirty_at IS NOT DISTINCT FROM ${row.embeddingDirtyAt}
         AND psychological_summary IS NOT DISTINCT FROM ${row.psychologicalSummary}
         AND partner_preferences IS NOT DISTINCT FROM ${row.partnerPreferences}
         AND negative_constraints IS NOT DISTINCT FROM ${row.negativeConstraints}
         AND hobbies IS NOT DISTINCT FROM ${row.hobbies}
    `;
    if (updated > 0) return "refreshed";
    if (!selection.aggregateOnly) {
      console.log(
        `[embedding-refresh] skipped userId=${row.userId} — row re-dirtied during refresh`,
      );
    }
    return "stale";
  };

  // One request per CHUNK, not per profile. This is the whole point of the
  // change: the weekly preflight used to open one HTTP round-trip per dirty
  // profile at concurrency 4, so thousands of profiles became a serial wall in
  // front of the drop. A failed chunk fails only its own rows, which stay dirty
  // and are retried by the next pass.
  const chunks: Row[][] = [];
  for (let i = 0; i < dirty.length; i += EMBEDDING_INPUTS_PER_REQUEST) {
    chunks.push(dirty.slice(i, i + EMBEDDING_INPUTS_PER_REQUEST));
  }

  const refreshChunk = async (rows: Row[]): Promise<Array<"refreshed" | "failed" | "stale">> => {
    let vectors: number[][];
    try {
      const pending = client.embedMany(rows.map(composeInput));
      vectors = options.timeoutMs ? await withTimeout(pending, options.timeoutMs) : await pending;
      if (vectors.length !== rows.length) {
        throw new Error(`asked for ${rows.length} embeddings, got ${vectors.length}`);
      }
    } catch (err) {
      if (!selection.aggregateOnly) {
        console.warn(
          `[embedding-refresh] failed for ${rows.length} profile(s):`,
          err instanceof Error ? err.message : err,
        );
      }
      return rows.map(() => "failed" as const);
    }

    // The writes are per row and independent, so one CAS race never costs the
    // rest of the chunk its refresh.
    return await mapWithConcurrency(
      rows.map((row, index) => ({ row, vec: vectors[index]! })),
      Math.max(1, Math.floor(options.concurrency ?? DEFAULT_EMBEDDING_REFRESH_CONCURRENCY)),
      async ({ row, vec }) => {
        try {
          return await persist(row, vec);
        } catch (err) {
          if (!selection.aggregateOnly) {
            console.warn(
              `[embedding-refresh] failed userId=${row.userId}:`,
              err instanceof Error ? err.message : err,
            );
          }
          return "failed" as const;
        }
      },
    );
  };

  const outcomes = (
    await mapWithConcurrency(
      chunks,
      Math.max(1, Math.floor(options.concurrency ?? DEFAULT_EMBEDDING_REFRESH_CONCURRENCY)),
      refreshChunk,
    )
  ).flat();
  const refreshed = outcomes.filter((outcome) => outcome === "refreshed").length;
  const failed = outcomes.filter((outcome) => outcome === "failed").length;

  return {
    scanned: dirty.length,
    refreshed,
    failed,
    stillDirty: dirty.length - refreshed,
  };
}

/** Execute a complete snapshot with a bounded worker pool. The input is
 * captured before this runs, so rows dirtied later are intentionally retried
 * by the next tick/preflight rather than extending this batch indefinitely. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Embedding refresh timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
