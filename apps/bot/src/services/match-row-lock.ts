import type { Prisma } from "@gennety/db";

/**
 * Serialise everything that decides from BOTH sides of one match row.
 *
 * A compare-and-set on `status` is enough when a write only has to lose
 * cleanly. It is not enough when the decision itself is computed from the
 * partner's columns: two requests can each read the other side before either
 * commits (or one commits between the other's read and its write), and the
 * status CAS still matches. Examples this exists for: the calendar
 * intersection, the stall worker's "who ghosted", the venue board's "does the
 * partner still have marks".
 *
 * `SELECT … FOR UPDATE` inside the caller's `$transaction` holds the row until
 * commit; every plain `UPDATE` of the same row (including the status CAS
 * writes elsewhere) waits behind it and then re-evaluates its WHERE against the
 * committed result. Keep the locked section to database work only — Telegram,
 * APNs and LLM calls run after the transaction commits.
 */
export async function lockMatchRow(
  tx: Prisma.TransactionClient,
  matchId: string,
): Promise<void> {
  await tx.$queryRawUnsafe("SELECT id FROM matches WHERE id = $1::uuid FOR UPDATE", matchId);
}
