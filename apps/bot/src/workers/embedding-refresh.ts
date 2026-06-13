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

export interface EmbeddingRefreshOptions {
  /** Cap rows touched per tick. Default 20 — balances OpenAI cost vs. lag. */
  batchSize?: number;
  /** Test injection: override the OpenAI embedding client. */
  client?: EmbeddingClient;
}

export interface EmbeddingRefreshResult {
  scanned: number;
  refreshed: number;
  failed: number;
}

/**
 * One refresh tick. Returns counts for logging. Never throws — a failed
 * row is logged + left dirty for the next tick.
 */
export async function embeddingRefreshTick(
  options: EmbeddingRefreshOptions = {},
): Promise<EmbeddingRefreshResult> {
  const batchSize = options.batchSize ?? DEFAULT_EMBEDDING_REFRESH_BATCH;
  const client =
    options.client ??
    (env.OPENAI_API_KEY ? createOpenAIEmbeddingClient(env.OPENAI_API_KEY) : null);

  // Without an OpenAI key we can't refresh. Stay quiet — local dev uses this.
  if (!client) return { scanned: 0, refreshed: 0, failed: 0 };

  const dirty = await prisma.profile.findMany({
    where: { embeddingDirty: true },
    orderBy: { embeddingDirtyAt: "asc" },
    take: batchSize,
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

  let refreshed = 0;
  let failed = 0;
  for (const row of dirty) {
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

      const vec = await client.embed(text.slice(0, 8000));
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
      `;
      if (updated > 0) {
        refreshed++;
      } else {
        // Row was re-dirtied while we were generating. Next tick picks it up.
        console.log(
          `[embedding-refresh] skipped userId=${row.userId} — row re-dirtied during refresh`,
        );
      }
    } catch (err) {
      failed++;
      console.warn(
        `[embedding-refresh] failed userId=${row.userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { scanned: dirty.length, refreshed, failed };
}
