import type { Prisma } from "@gennety/db";

/**
 * Shared Prisma `where` fragments for the `matches` table.
 *
 * These exist because the obvious spelling of "the pair has NOT both
 * accepted" is a **silent data-loss bug** on nullable tri-state columns.
 * `Match.acceptedByA/B` are `Boolean?` — `null` (undecided), `true`, or
 * `false` — and the natural-looking filter
 *
 *   NOT: { AND: [{ acceptedByA: true }, { acceptedByB: true }] }
 *
 * compiles to `NOT (accepted_by_a = true AND accepted_by_b = true)`. Under
 * Postgres three-valued logic a fresh proposal (both columns `null`) makes
 * that `NOT (NULL AND NULL)` → `NULL`, which is not `TRUE`, so the row is
 * **excluded**. The filter therefore dropped exactly the rows it was meant
 * to keep: pairs where nobody has answered yet. Verified against a live
 * proposal on 2026-07-25 (baseline 1 row → 0 rows through the `NOT/AND`).
 *
 * The Prisma-idiomatic-looking repair is also wrong: `{ acceptedByA: { not:
 * true } }` emits a comparison that discards `null` the same way (measured:
 * still 0 rows). Only an explicit `null | false` enumeration is null-safe,
 * so that is what these constants spell out.
 *
 * Keep every "still undecided" query pointed at this constant — the bug is
 * invisible in unit tests that mock Prisma (a mock ignores `where`), so a
 * re-introduced `NOT/AND` would silently disable a whole worker again.
 */

/**
 * Matches where the pair has NOT both accepted — i.e. the proposal is still
 * open for at least one side (undecided, or actively declined).
 *
 * Used by every `proposed`-phase sweep: the live reply-deadline countdown,
 * the proposal / deadline nudges, and the 24h TTL expiry. A pair that has
 * both accepted is owned by the decision handler (it is about to flip to
 * `negotiating`), so those sweeps must skip it — but ONLY it.
 */
export const PAIR_NOT_BOTH_ACCEPTED: Prisma.MatchWhereInput = {
  OR: [
    { acceptedByA: null },
    { acceptedByA: false },
    { acceptedByB: null },
    { acceptedByB: false },
  ],
};
