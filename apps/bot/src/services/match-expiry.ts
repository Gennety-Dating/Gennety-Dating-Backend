import { prisma } from "@gennety/db";

/**
 * 24-hour TTL expiration for dispatched match proposals.
 *
 * Matches that were dispatched (pitch sent) but not mutually accepted
 * within 24 hours are automatically marked as `expired`.
 *
 * A match is expired when:
 *   - status is `proposed`
 *   - `dispatchedAt` is set and older than 24 hours
 *   - NOT both `acceptedByA` AND `acceptedByB` are true
 */

export const MATCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ExpiryResult {
  expired: number;
}

/**
 * Find and expire all proposed matches that have exceeded the 24h TTL.
 */
export async function expireStaleMatches(
  ttlMs: number = MATCH_TTL_MS,
): Promise<ExpiryResult> {
  const cutoff = new Date(Date.now() - ttlMs);

  const result = await prisma.match.updateMany({
    where: {
      status: "proposed",
      dispatchedAt: { not: null, lt: cutoff },
      // At least one side hasn't accepted — if both accepted, the
      // decision handler would have already transitioned to negotiating.
      NOT: {
        AND: [
          { acceptedByA: true },
          { acceptedByB: true },
        ],
      },
    },
    data: { status: "expired" },
  });

  if (result.count > 0) {
    console.log(`[expiry] expired ${result.count} stale matches (TTL=${ttlMs}ms)`);
  }

  return { expired: result.count };
}
