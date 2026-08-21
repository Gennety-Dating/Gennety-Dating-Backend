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
  /**
   * Matches whose pitch reached **neither** side and were therefore retired
   * (see `disposeUndeliveredMatch`).
   *
   * Reported rather than left for the caller to re-derive, because by the time
   * `dispatchMatches` returns the row is already `cancelled` and carries no
   * pitch ids — the evidence that nobody was reached is gone. A caller that
   * took money for this pitch needs that distinction: `errors` alone cannot
   * tell "one side got the card" from "nobody did" (§3.11, D1).
   */
  undelivered: string[];
}

/**
 * Sleep for `ms` milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispose of a match whose dispatch threw, so it can never be left both live
 * and un-stamped.
 *
 * The invariant: **a dispatch attempt leaves the row either carrying a TTL or
 * terminal.** Every other consumer of a `proposed` row — the expiry sweep, the
 * countdown worker, both nudge cadences — filters on `dispatchedAt: { not: null }`,
 * so a row that keeps `dispatchedAt = null` is invisible to all of them at once.
 * It never expires, never nudges, never counts down; meanwhile the
 * single-live-match rule (§3.2 filter 8) keeps BOTH participants out of every
 * drop. That is not a degraded match, it is a permanent silent hole: production
 * held one for 123 hours, and the user on the other side of it received nothing
 * for five days while everyone else got a pitch every evening (DECISIONS.md
 * 2026-08-20).
 *
 * Two outcomes, decided by whether anyone actually received a pitch:
 *
 *   - **At least one side did** (`pitchMessageIdA`/`B` recorded) → start the TTL.
 *     The delivered side can act on a real card, and the 24h window is the right
 *     way to close it if they don't.
 *   - **Nobody did** → cancel. Stamping here would be worse than the hole it
 *     closes: the expiry path classifies a non-answering side as *silent*,
 *     increments `silentIgnoreCount` and sends "24 hours passed with no answer",
 *     which is a penalty for ghosting a message that was never sent. A match that
 *     reached nobody is not a match — retiring it frees both slots, penalises
 *     nobody, and tells nobody about a card they never saw.
 *
 * Both branches are compare-and-set on the state they read, so a decision or a
 * cancellation that landed while Telegram was timing out always wins.
 *
 * Best-effort by construction: this runs inside the caller's `catch`, and its
 * own failure must not mask the delivery error that got us here.
 */
async function disposeUndeliveredMatch(
  matchId: string,
): Promise<"stamped" | "cancelled" | "noop"> {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { dispatchedAt: true, pitchMessageIdA: true, pitchMessageIdB: true },
  });
  if (!m || m.dispatchedAt !== null) return "noop";

  if (m.pitchMessageIdA !== null || m.pitchMessageIdB !== null) {
    await prisma.match.updateMany({
      where: { id: matchId, status: "proposed", dispatchedAt: null },
      data: { dispatchedAt: new Date() },
    });
    return "stamped";
  }

  const cancelled = await prisma.match.updateMany({
    where: { id: matchId, status: "proposed", dispatchedAt: null },
    data: { status: "cancelled" },
  });
  if (cancelled.count > 0) {
    // Loud on purpose. A pair the product created and could not deliver is an
    // ops signal — the batch's own `failed=N` line says a send failed, not that
    // two people were just taken out of the pool and put back.
    console.error(
      `[dispatch] matchId=${matchId} reached NEITHER side — cancelled so both ` +
        "participants are freed for the next drop",
    );
    return "cancelled";
  }
  // The CAS claimed nothing: a decision or a cancellation won the race, so this
  // is not an undelivered pair and must not be reported as one.
  return "noop";
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
  const undelivered: string[] = [];
  const preRolledSides = new Map<string, { A?: boolean; B?: boolean }>();

  if (prerollDelayMs > 0 && matchIds.length > 0) {
    let prerollSent = 0;
    for (let i = 0; i < matchIds.length; i++) {
      const matchId = matchIds[i]!;
      try {
        const dispatchable = await prisma.match.findFirst({
          where: { id: matchId, status: "proposed" },
          select: { id: true },
        });
        if (!dispatchable) continue;
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
      const dispatchable = await prisma.match.findFirst({
        where: { id: matchId, status: "proposed" },
        select: { id: true },
      });
      if (!dispatchable) continue;
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
      const stamped = await prisma.match.updateMany({
        where: { id: matchId, status: "proposed" },
        data: { dispatchedAt: new Date() },
      });
      // A cancellation can win while a Telegram request is in flight. Never
      // resurrect its TTL state or report it as a successfully dispatched
      // proposal; cancellation owns the terminal outcome.
      if (stamped.count === 0) continue;
      dispatched++;
      console.log(
        `[dispatch] ${i + 1}/${matchIds.length} matchId=${matchId} OK`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A throw here says nothing about how much was delivered: it can mean ONE
      // side received the pitch (the other's send failed every retry, e.g. that
      // user blocked the bot) or that nobody did. `sendMatchProposal` is per-side
      // idempotent, so a delivered side is never re-DMed — but the row must not
      // be left `proposed` with `dispatchedAt = null`, which is invisible to the
      // expiry sweep, the countdown and both nudge cadences at once while still
      // occupying both participants' single live-match slot. `disposeUndeliveredMatch`
      // starts the TTL when a pitch is on record and retires the row when none is.
      const disposal = await disposeUndeliveredMatch(matchId).catch((e) => {
        console.warn(
          `[dispatch] disposal failed matchId=${matchId}:`,
          e,
        );
        // Unknown rather than undelivered. A caller holding money must not
        // refund on a disposal we could not complete: the row may still be
        // live with a delivered side.
        return "noop" as const;
      });
      if (disposal === "cancelled") undelivered.push(matchId);
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
    `[dispatch] done: dispatched=${dispatched} failed=${errors.length}` +
      (undelivered.length > 0 ? ` undelivered=${undelivered.length}` : ""),
  );

  return { dispatched, failed: errors.length, errors, undelivered };
}
