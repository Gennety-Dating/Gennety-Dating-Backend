import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { sendMatchProposal } from "../handlers/matching/pitch.js";

/**
 * Rate-limited dispatch queue for match pitches.
 *
 * After the weekly batch creates `proposed` Match rows, this queue
 * dispatches AI pitches sequentially with a configurable delay between
 * each message pair to avoid Telegram & OpenAI rate limits (429).
 *
 * Default: ~2 seconds between dispatches = ~30 matches/minute.
 */

export const DEFAULT_DISPATCH_DELAY_MS = 2000;

export interface DispatchResult {
  dispatched: number;
  failed: number;
  errors: Array<{ matchId: string; error: string }>;
}

/**
 * Sleep for `ms` milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispatch AI pitches for a list of match IDs, rate-limited.
 *
 * For each match:
 *   1. Call `sendMatchProposal` (streams the pitch to both users).
 *   2. Stamp `dispatchedAt` on the match row (used by the 24h TTL cron).
 *   3. Wait `delayMs` before the next dispatch.
 *
 * Failures are logged and skipped — the queue continues to the next match.
 */
export async function dispatchMatches(
  api: Api<RawApi>,
  matchIds: string[],
  delayMs: number = DEFAULT_DISPATCH_DELAY_MS,
): Promise<DispatchResult> {
  let dispatched = 0;
  const errors: DispatchResult["errors"] = [];

  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i]!;
    try {
      await sendMatchProposal(api, matchId);
      await prisma.match.update({
        where: { id: matchId },
        data: { dispatchedAt: new Date() },
      });
      dispatched++;
      console.log(
        `[dispatch] ${i + 1}/${matchIds.length} matchId=${matchId} OK`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ matchId, error: message });
      console.error(
        `[dispatch] ${i + 1}/${matchIds.length} matchId=${matchId} FAILED: ${message}`,
      );
    }

    // Rate-limit: wait before the next dispatch (skip after last).
    if (i < matchIds.length - 1) {
      await delay(delayMs);
    }
  }

  console.log(
    `[dispatch] done: dispatched=${dispatched} failed=${errors.length}`,
  );

  return { dispatched, failed: errors.length, errors };
}
