import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  sendMatchProposal,
  sendMatchWelcomeGiftPreroll,
} from "../handlers/matching/pitch.js";

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
 * Start the 24h TTL clock for a match whose dispatch threw mid-way but where at
 * least one side already received the pitch. Idempotent: only stamps a row that
 * is still un-stamped (`dispatchedAt = null`) and has a recorded pitch
 * (`pitchMessageIdA`/`B`). Without this, a one-sided delivery would leave
 * `dispatchedAt` null and the row would never satisfy the expiry query
 * (`dispatchedAt: { not: null, lt: cutoff }`), stranding it in `proposed`.
 */
async function stampDispatchedIfDelivered(matchId: string): Promise<void> {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { dispatchedAt: true, pitchMessageIdA: true, pitchMessageIdB: true },
  });
  if (!m || m.dispatchedAt !== null) return;
  if (m.pitchMessageIdA === null && m.pitchMessageIdB === null) return;
  await prisma.match.updateMany({
    where: { id: matchId, dispatchedAt: null },
    data: { dispatchedAt: new Date() },
  });
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
  maxAttempts: number = 3,
  prerollDelayMs: number = 0,
): Promise<DispatchResult> {
  let dispatched = 0;
  const errors: DispatchResult["errors"] = [];
  const preRolledSides = new Map<string, { A?: boolean; B?: boolean }>();

  if (prerollDelayMs > 0 && matchIds.length > 0) {
    let prerollSent = 0;
    for (let i = 0; i < matchIds.length; i++) {
      const matchId = matchIds[i]!;
      try {
        const result = await sendMatchWelcomeGiftPreroll(api, matchId);
        if (result.sent > 0) {
          prerollSent += result.sent;
          preRolledSides.set(matchId, { A: result.sentA, B: result.sentB });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[dispatch] welcome-gift pre-roll failed matchId=${matchId}: ${message}`,
        );
      }
      if (i < matchIds.length - 1) {
        await delay(delayMs);
      }
    }
    if (prerollSent > 0) {
      console.log(
        `[dispatch] welcome-gift pre-roll sent=${prerollSent}; waiting ${prerollDelayMs}ms before pitches`,
      );
      await delay(prerollDelayMs);
    }
  }

  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i]!;
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const preRolled = preRolledSides.get(matchId);
          await sendMatchProposal(
            api,
            matchId,
            preRolled ? { skipWelcomeGiftPreroll: preRolled } : {},
          );
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < maxAttempts) await delay(delayMs);
        }
      }
      if (lastError !== undefined) throw lastError;
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
      // A throw here can still mean ONE side received the pitch (the other
      // side's send failed every retry, e.g. that user blocked the bot).
      // `sendMatchProposal` is per-side idempotent, so the delivered side is
      // never re-DMed — but if we never stamp `dispatchedAt`, the 24h TTL
      // expiry query (`dispatchedAt: { not: null }`) excludes this row forever
      // and the match is stranded in `proposed`: it never expires, and the
      // delivered side can accept into a dead end. Salvage by starting the TTL
      // clock whenever at least one pitch is on record.
      await stampDispatchedIfDelivered(matchId).catch((e) => {
        console.warn(
          `[dispatch] dispatchedAt salvage failed matchId=${matchId}:`,
          e,
        );
      });
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
