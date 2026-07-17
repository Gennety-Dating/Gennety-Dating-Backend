import type { MatchStatus } from "@gennety/db";

/** Every status that still occupies a user's single live-match slot. */
export const ACTIVE_MATCH_STATUSES: readonly MatchStatus[] = [
  "proposed",
  "negotiating",
  "negotiating_venue",
  "scheduled",
];

/** Product priority for a corrupted/legacy account that has multiple live rows. */
export const CURRENT_MATCH_STATUS_PRIORITY: readonly MatchStatus[] = [
  "scheduled",
  "negotiating_venue",
  "negotiating",
  "proposed",
];

const STATUS_RANK = new Map(
  CURRENT_MATCH_STATUS_PRIORITY.map((status, index) => [status, index]),
);

/** Pick the most progressed match. Input order breaks ties, so callers should
 * query `createdAt desc` to select the newest row within a status. */
export function pickCurrentMatch<T extends { status: MatchStatus }>(
  matches: readonly T[],
): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    const rank = STATUS_RANK.get(match.status) ?? Number.POSITIVE_INFINITY;
    if (rank < bestRank) {
      best = match;
      bestRank = rank;
    }
  }
  return best;
}
