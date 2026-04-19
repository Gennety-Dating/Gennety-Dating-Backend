import { prisma } from "./index.js";

/**
 * Functional index on the `matches` table for the lifetime anti-rematch
 * lookup. `(user_a_id, user_b_id)` is stored unordered, so we index the
 * canonical ordering — `LEAST/GREATEST` — so the `NOT EXISTS` guard in
 * `buildCandidateSql` stays O(log n) as the match history grows.
 *
 * `CREATE INDEX IF NOT EXISTS` is idempotent: safe to call on every boot
 * under the `db push` workflow. Promote to a real migration when the
 * project adopts `prisma migrate`.
 */
export async function ensureMatchPairIndex(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS matches_pair_canonical_idx
       ON matches (
         LEAST(user_a_id, user_b_id),
         GREATEST(user_a_id, user_b_id)
       )`,
  );
}
