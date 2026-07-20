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
 */
export async function refreshAllDirtyEmbeddings(
  options: Omit<EmbeddingRefreshOptions, "batchSize"> = {},
): Promise<EmbeddingRefreshResult> {
  return refreshDirtyEmbeddings(
    { aggregateOnly: true },
    { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_EMBEDDING_REFRESH_TIMEOUT_MS },
  );
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

  const refreshOne = async (row: (typeof dirty)[number]): Promise<"refreshed" | "failed" | "stale"> => {
    try {
      // Compose a normalised text representation. Re-using
      // `buildEmbeddingInput` keeps this consistent with the onboarding
      // pipeline; `partnerPreferences` and `negativeConstraints` are
      // appended below since the original helper only knows about the
      // structured `ParsedProfileSummary`.
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

      const embeddingPromise = client.embed(text.slice(0, 8000));
      const vec = options.timeoutMs
        ? await withTimeout(embeddingPromise, options.timeoutMs)
        : await embeddingPromise;
      const literal = toPgVectorLiteral(vec);

      // Vector + flag update is atomic. If the row was re-dirtied while the
      // embedding request was in flight, the timestamp guard makes this a no-op.
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
      if (updated > 0) {
        return "refreshed";
      } else {
        // Row was re-dirtied while we were generating. Next tick picks it up.
        if (!selection.aggregateOnly) {
          console.log(
            `[embedding-refresh] skipped userId=${row.userId} — row re-dirtied during refresh`,
          );
        }
        return "stale";
      }
    } catch (err) {
      if (!selection.aggregateOnly) {
        console.warn(
          `[embedding-refresh] failed userId=${row.userId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return "failed";
    }
  };

  const outcomes = await mapWithConcurrency(
    dirty,
    Math.max(1, Math.floor(options.concurrency ?? DEFAULT_EMBEDDING_REFRESH_CONCURRENCY)),
    refreshOne,
  );
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
