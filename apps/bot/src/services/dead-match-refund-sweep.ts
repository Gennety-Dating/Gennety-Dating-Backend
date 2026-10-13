import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  DEAD_MATCH_REFUND_GRACE_MS,
  DEAD_MATCH_REFUND_LOOKBACK_DAYS,
  t,
} from "@gennety/shared";
import {
  notifyFounderDeadMatchRefundRecovered,
  notifyFounderOrphanedPassReview,
} from "./founder-notify.js";
import { PRIME_PURCHASE_SETTLED, refundPrimeTimeForDeadMatch } from "./prime-time-purchase.js";
import { sendPushToUser } from "./push.js";
import {
  applyTicketRefunds,
  matchRefundKey,
  planMatchTicketRefunds,
  ticketRefundNoticeKey,
  TICKET_REFUND_SKIP_STATUSES,
  type TicketRefundCredit,
  type TicketRefundOutcome,
} from "./ticket-refund.js";
import { APPSTORE_PAYMENT_PREFIX } from "./venue-change-refund.js";

/**
 * Hourly recovery of refunds a cancellation owed and never paid
 * (decision 2026-10-13).
 *
 * Every rail that kills a paid match — emergency cancel, the 48h stall, block,
 * report, moderation, freeze — commits the cancellation first and refunds
 * after, on purpose: a Telegram call must never sit inside a transaction. The
 * price was a window: a process that died between the two (a deploy restart,
 * a crash) left a cancelled match whose tickets and Prime Time pass were never
 * returned, and nothing ever looked again.
 *
 * Nothing new is stored to make this durable. The cancelled match row IS the
 * record: re-planning it gives exactly what the live rail would have paid, and
 * both refunds are already exactly-once — wallet tickets by the
 * `refund:match:<match>:<user>:<slot>` ledger key, Prime Time passes by the CAS
 * on `settled`. So the sweep simply runs them again; on a match that was
 * refunded normally it finds nothing to do.
 *
 * Three passes:
 *   1. Tickets on cancelled matches — refunded automatically, payer told.
 *   2. Prime Time passes on cancelled matches — refunded automatically (the
 *      live helper messages the payer itself).
 *   3. Prime Time passes whose match row is GONE (erased with a deleted
 *      account) — sent to the founder to decide, not refunded: with the row
 *      gone nothing says whether the date happened first. Tickets need no such
 *      pass: account deletion now credits the partner inside its own
 *      transaction (`applyTicketRefundsInTx`).
 *
 * Every recovery is reported to the founder: it means a crash landed in that
 * window, which is worth knowing even when nobody ended up out of pocket.
 */

/** Per-tick caps. Generous for today's volume; a full page just waits an hour. */
const TICKET_CANDIDATES_PER_TICK = 200;
const PASS_MATCHES_PER_TICK = 50;
const ORPHANED_PASSES_PER_TICK = 50;

/**
 * `refundError` markers on a `settled` pass whose match row is gone. Nothing
 * else reads `refundError` on a settled row (it is the refund rails' column,
 * and they only ever write it on the way OUT of `settled`).
 *
 * Seen first, reported one tick later: account deletion erases the match and
 * then refunds the pass a moment after its commit, and a sweep that read the
 * row inside that moment must not page the founder about a refund that is
 * about to happen. A refund in the meantime moves the row off `settled`, so
 * the second sighting never comes.
 */
const ORPHAN_SEEN_PREFIX = "orphan_seen:";
const ORPHAN_REPORTED_PREFIX = "founder_review:";

export interface DeadMatchRefundSweepResult {
  ticketMatchesScanned: number;
  ticketsRecovered: number;
  passMatchesRecovered: number;
  orphanedPassesReported: number;
}

export async function sweepDeadMatchRefunds(
  api: Api<RawApi> | null,
  now: Date = new Date(),
): Promise<DeadMatchRefundSweepResult> {
  const settledBefore = new Date(now.getTime() - DEAD_MATCH_REFUND_GRACE_MS);
  const notBefore = new Date(now.getTime() - DEAD_MATCH_REFUND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const tickets = await recoverTicketRefunds(api, settledBefore, notBefore);
  const passes = await recoverPrimeTimePasses(api, settledBefore);
  const orphaned = await reviewOrphanedPasses(now, settledBefore);

  // Founder messages per match: tickets and the pass of one match go together.
  const recoveredMatchIds = new Set([...tickets.byMatch.keys(), ...passes.keys()]);
  for (const matchId of recoveredMatchIds) {
    await notifyFounderDeadMatchRefundRecovered({
      matchId,
      tickets: (tickets.byMatch.get(matchId) ?? []).map((o) => ({
        userId: o.userId,
        refunded: o.refunded,
      })),
      primeTimePasses: passes.get(matchId) ?? 0,
    });
  }

  const result: DeadMatchRefundSweepResult = {
    ticketMatchesScanned: tickets.scanned,
    ticketsRecovered: [...tickets.byMatch.values()]
      .flat()
      .reduce((sum, o) => sum + o.refunded, 0),
    passMatchesRecovered: passes.size,
    orphanedPassesReported: orphaned,
  };
  if (recoveredMatchIds.size > 0 || orphaned > 0) {
    console.warn(
      `[dead-match-refund] recovered tickets=${result.ticketsRecovered} ` +
        `passMatches=${result.passMatchesRecovered} orphanedPassesReported=${orphaned}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. Tickets
// ---------------------------------------------------------------------------

async function recoverTicketRefunds(
  api: Api<RawApi> | null,
  settledBefore: Date,
  notBefore: Date,
): Promise<{ scanned: number; byMatch: Map<string, TicketRefundOutcome[]> }> {
  const candidates = await prisma.match.findMany({
    where: {
      status: "cancelled",
      updatedAt: { gte: notBefore, lte: settledBefore },
      OR: [{ ticketPaidA: { not: null } }, { ticketPaidB: { not: null } }],
      // The ticket-expiry rail owns these; the planner would skip them anyway.
      ticketStatus: { notIn: [...TICKET_REFUND_SKIP_STATUSES] },
    },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: TICKET_CANDIDATES_PER_TICK,
  });

  const byMatch = new Map<string, TicketRefundOutcome[]>();
  for (const { id } of candidates) {
    try {
      const outstanding = await outstandingTicketCredits(id);
      if (outstanding.length === 0) continue;
      const outcomes = (await applyTicketRefunds(outstanding)).filter((o) => o.refunded > 0);
      if (outcomes.length === 0) continue;
      byMatch.set(id, outcomes);
      for (const outcome of outcomes) await tellPayer(api, id, outcome);
    } catch (err) {
      // One bad row must not cost the rest of the page its recovery.
      console.error(`[dead-match-refund] ticket recovery failed match=${id}:`, err);
    }
  }
  return { scanned: candidates.length, byMatch };
}

/**
 * The plan the live rail would have executed, minus the slots it already
 * credited. Filtering here, rather than letting `applyTicketRefunds` bounce
 * off the unique key, keeps a normally-refunded match to two reads per tick
 * instead of a failed insert per slot.
 */
async function outstandingTicketCredits(matchId: string): Promise<TicketRefundCredit[]> {
  const plan = await planMatchTicketRefunds(matchId);
  if (plan.length === 0) return [];
  const keys = plan.flatMap((credit) =>
    credit.slots.map((slot) => matchRefundKey(matchId, credit.userId, slot)),
  );
  const done = await prisma.ticketLedger.findMany({
    where: { externalPaymentId: { in: keys } },
    select: { externalPaymentId: true },
  });
  const paid = new Set(done.map((row) => row.externalPaymentId));
  return plan
    .map((credit) => ({
      ...credit,
      slots: credit.slots.filter((slot) => !paid.has(matchRefundKey(matchId, credit.userId, slot))),
    }))
    .filter((credit) => credit.slots.length > 0);
}

/** The same one-line notice the cancellation rails send with a refund. */
async function tellPayer(
  api: Api<RawApi> | null,
  matchId: string,
  outcome: TicketRefundOutcome,
): Promise<void> {
  const key = ticketRefundNoticeKey(outcome.refunded);
  if (!key) return;
  const body = t(outcome.language, key);
  if (
    api &&
    outcome.telegramId > 0n &&
    (outcome.platform === "telegram" || outcome.platform === "both")
  ) {
    await api.sendMessage(Number(outcome.telegramId), body).catch((err: unknown) => {
      console.warn("[dead-match-refund] refund notice failed:", err);
    });
  }
  if (outcome.platform === "mobile" || outcome.platform === "both") {
    await sendPushToUser(outcome.userId, {
      title: "Gennety",
      body,
      data: { type: "ticket.refunded", matchId },
    }).catch((err: unknown) => {
      console.warn("[dead-match-refund] refund push failed:", err);
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Prime Time passes on cancelled matches
// ---------------------------------------------------------------------------

/**
 * A pass still `settled` on a cancelled match is always owed (§9.1: the pass
 * follows the ticket). No lookback here: settled passes on cancelled matches
 * do not accumulate — every one of them is moved off `settled` by a refund —
 * so the join stays small without one.
 */
async function recoverPrimeTimePasses(
  api: Api<RawApi> | null,
  settledBefore: Date,
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ matchId: string }[]>`
    SELECT DISTINCT p.match_id::text AS "matchId"
    FROM prime_time_purchases p
    JOIN matches m ON m.id = p.match_id
    WHERE p.status = ${PRIME_PURCHASE_SETTLED}
      AND m.status = 'cancelled'
      AND m.updated_at <= ${settledBefore}
    LIMIT ${PASS_MATCHES_PER_TICK}`;

  const recovered = new Map<string, number>();
  for (const { matchId } of rows) {
    try {
      const before = await settledPassCount(matchId);
      // Stars passes are refunded (and the payer told) by the live helper; App
      // Store passes are parked for Apple's refund and announced by it.
      await refundPrimeTimeForDeadMatch(matchId, api);
      const moved = before - (await settledPassCount(matchId));
      if (moved > 0) recovered.set(matchId, moved);
    } catch (err) {
      console.error(`[dead-match-refund] pass recovery failed match=${matchId}:`, err);
    }
  }
  return recovered;
}

function settledPassCount(matchId: string): Promise<number> {
  return prisma.primeTimePurchase.count({
    where: { matchId, status: PRIME_PURCHASE_SETTLED },
  });
}

// ---------------------------------------------------------------------------
// 3. Prime Time passes whose match is gone — to the founder
// ---------------------------------------------------------------------------

async function reviewOrphanedPasses(now: Date, settledBefore: Date): Promise<number> {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      matchId: string;
      userId: string | null;
      amountStars: number;
      externalPaymentId: string;
      refundError: string | null;
      createdAt: Date;
    }[]
  >`
    SELECT p.id::text AS id,
           p.match_id::text AS "matchId",
           p.user_id::text AS "userId",
           p.amount_stars AS "amountStars",
           p.external_payment_id AS "externalPaymentId",
           p.refund_error AS "refundError",
           p.created_at AS "createdAt"
    FROM prime_time_purchases p
    LEFT JOIN matches m ON m.id = p.match_id
    WHERE p.status = ${PRIME_PURCHASE_SETTLED}
      AND m.id IS NULL
      AND (p.refund_error IS NULL OR p.refund_error LIKE ${`${ORPHAN_SEEN_PREFIX}%`})
    ORDER BY p.created_at ASC
    LIMIT ${ORPHANED_PASSES_PER_TICK}`;

  let reported = 0;
  for (const row of rows) {
    const seenAt = orphanSeenAt(row.refundError);
    if (!seenAt) {
      await prisma.primeTimePurchase.updateMany({
        where: { id: row.id, status: PRIME_PURCHASE_SETTLED, refundError: null },
        data: { refundError: `${ORPHAN_SEEN_PREFIX} ${now.toISOString()}` },
      });
      continue;
    }
    if (seenAt.getTime() > settledBefore.getTime()) continue;

    const sent = await notifyFounderOrphanedPassReview({
      purchaseId: row.id,
      matchId: row.matchId,
      userId: row.userId,
      amountStars: row.amountStars,
      externalPaymentId: row.externalPaymentId,
      appStore: row.externalPaymentId.startsWith(APPSTORE_PAYMENT_PREFIX),
      createdAt: row.createdAt,
    });
    // Marked only once the founder has actually got it: a disabled or failing
    // founder feed leaves the row to be offered again next hour.
    if (!sent) continue;
    await prisma.primeTimePurchase.updateMany({
      where: { id: row.id, status: PRIME_PURCHASE_SETTLED, refundError: row.refundError },
      data: { refundError: `${ORPHAN_REPORTED_PREFIX} reported ${now.toISOString()}` },
    });
    reported++;
  }
  return reported;
}

/** When the sweep first saw this pass orphaned, or null if it has not yet. */
export function orphanSeenAt(refundError: string | null): Date | null {
  if (!refundError?.startsWith(ORPHAN_SEEN_PREFIX)) return null;
  const seen = new Date(refundError.slice(ORPHAN_SEEN_PREFIX.length).trim());
  return Number.isNaN(seen.getTime()) ? null : seen;
}
