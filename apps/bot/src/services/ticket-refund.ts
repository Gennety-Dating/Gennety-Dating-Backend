import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { grantTickets, isUniqueViolation } from "./ticket-wallet.js";

/**
 * Date Ticket refunds for a date that never happened (PRODUCT_SPEC §3.5b).
 *
 * One rule, no fault-finding: when a live match dies before the date, every
 * ticket that was actually paid for goes back to whoever paid for it. The
 * person who cancelled honestly is refunded exactly like the person who was
 * cancelled on — the penalty for flaking already exists in Elo /
 * `silentIgnoreCount`, and taking the money on top would make an honest
 * cancellation more expensive than a silent no-show.
 *
 * The refund lands in the ticket WALLET (`grantTickets`, reason `refund`), not
 * as a reverse Telegram Stars transaction. A Stars reversal is a provider call
 * that fails, and making it durable needs its own purchase table plus an hourly
 * sweep (the `venue_change_purchases` / `rematch_purchases` pattern). A wallet
 * credit is immediate, local, and exactly-once — the user keeps the value they
 * paid for and spends it on the next date.
 *
 * Who gets what: slot A refunds to user A and slot B to user B, EXCEPT when
 * `paidForPartnerBy*` says one side covered the other. Without that exception
 * the "I'm paying for us both" gesture would quietly turn into gifting the
 * partner a ticket she never bought.
 *
 * Two-phase by necessity, not by taste. `planMatchTicketRefunds` reads the
 * match (and can run inside the caller's transaction, while the row still
 * exists); `applyTicketRefunds` does the wallet writes after that transaction
 * commits. Account deletion cascades the match row away inside its own
 * transaction, so a post-commit `matchId` lookup would find nothing and the
 * surviving partner would silently lose their ticket.
 */

/**
 * Ticket statuses the expiry rail (`workers/ticket-expiry.ts` →
 * `refundAndFallbackToScheduling`) already owns. `refunded` means it has
 * already returned the money, `refund_pending` means it is mid-refund and
 * retrying hourly, and `expired` is only reached when nobody had paid at all.
 * Refunding on top of any of them would double-credit, so this rail stands
 * down and lets that one finish.
 */
export const TICKET_REFUND_SKIP_STATUSES = [
  "refunded",
  "refund_pending",
  "expired",
] as const;

export type TicketSlot = "A" | "B";

/** One payer's claim on a dead match: the slots they actually paid for. */
export interface TicketRefundCredit {
  matchId: string;
  userId: string;
  /** Slots this user paid for — 1, or 2 when they covered both. */
  slots: TicketSlot[];
  telegramId: bigint;
  language: Language;
  platform: string;
}

export interface TicketRefundOutcome {
  userId: string;
  /** Tickets newly credited by THIS call (0 when a previous call already did). */
  refunded: number;
  telegramId: bigint;
  language: Language;
  platform: string;
}

type RefundDb = Pick<typeof prisma, "match">;

const MATCH_REFUND_SELECT = {
  id: true,
  ticketStatus: true,
  ticketPaidA: true,
  ticketPaidB: true,
  paidForPartnerByA: true,
  paidForPartnerByB: true,
  userAId: true,
  userBId: true,
  userA: { select: { telegramId: true, language: true, platform: true } },
  userB: { select: { telegramId: true, language: true, platform: true } },
} as const;

/**
 * Work out who is owed a ticket back for `matchId`, without writing anything.
 *
 * Safe to call with a transaction client — and preferable, because reading the
 * match in the same transaction that cancels it means the row lock serialises
 * this against the expiry rail's own `negotiating`-guarded claim, rather than
 * leaving a window where both could decide to refund the same slot.
 *
 * Returns an empty plan for a match that was never paid for, one the expiry
 * rail already settled, or a match that no longer exists.
 */
export async function planMatchTicketRefunds(
  matchId: string,
  db: RefundDb = prisma,
): Promise<TicketRefundCredit[]> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: MATCH_REFUND_SELECT,
  });
  if (!match) return [];
  if ((TICKET_REFUND_SKIP_STATUSES as readonly string[]).includes(match.ticketStatus)) {
    return [];
  }

  const bySlot: Array<{ slot: TicketSlot; payerId: string }> = [];
  if (match.ticketPaidA !== null) {
    // `paidForPartnerByB` = B paid for A, so slot A's money came from B.
    bySlot.push({ slot: "A", payerId: match.paidForPartnerByB ? match.userBId : match.userAId });
  }
  if (match.ticketPaidB !== null) {
    bySlot.push({ slot: "B", payerId: match.paidForPartnerByA ? match.userAId : match.userBId });
  }
  if (bySlot.length === 0) return [];

  const credits = new Map<string, TicketRefundCredit>();
  for (const { slot, payerId } of bySlot) {
    const payer = payerId === match.userAId ? match.userA : match.userB;
    const existing = credits.get(payerId);
    if (existing) {
      existing.slots.push(slot);
      continue;
    }
    credits.set(payerId, {
      matchId: match.id,
      userId: payerId,
      slots: [slot],
      telegramId: payer.telegramId,
      language: (payer.language ?? "en") as Language,
      platform: payer.platform,
    });
  }
  return [...credits.values()];
}

/**
 * Execute a plan: one wallet ticket per paid slot, exactly once.
 *
 * Idempotency is the synthetic unique `TicketLedger.externalPaymentId`
 * (`refund:match:<matchId>:<userId>:<slot>`) — a repeat call hits the existing
 * unique index, `grantTickets` rolls its transaction back, and the slot counts
 * as already refunded rather than crediting a second ticket. Each slot is its
 * own transaction on purpose: a failure halfway through leaves the first credit
 * durable and the retry finishes only what is genuinely outstanding.
 *
 * A payer whose account no longer exists (GDPR hard delete) is skipped — their
 * wallet went with the row, and the point of running post-commit is that their
 * PARTNER still gets refunded.
 */
export async function applyTicketRefunds(
  credits: readonly TicketRefundCredit[],
): Promise<TicketRefundOutcome[]> {
  const outcomes: TicketRefundOutcome[] = [];

  for (const credit of credits) {
    const payer = await prisma.user
      .findUnique({ where: { id: credit.userId }, select: { id: true } })
      .catch((err: unknown) => {
        console.warn("[ticket-refund] payer lookup failed:", err);
        return null;
      });
    if (!payer) continue;

    let refunded = 0;
    for (const slot of credit.slots) {
      try {
        await grantTickets({
          userId: credit.userId,
          count: 1,
          reason: "refund",
          matchId: credit.matchId,
          externalPaymentId: `refund:match:${credit.matchId}:${credit.userId}:${slot}`,
        });
        refunded += 1;
      } catch (err) {
        // Already refunded by an earlier call — the whole point of the key.
        if (isUniqueViolation(err)) continue;
        console.error(
          `[ticket-refund] slot ${slot} refund failed for match ${credit.matchId}:`,
          err,
        );
      }
    }

    if (refunded > 0) {
      console.log(
        `[ticket-refund] returned ${refunded} ticket(s) to ${credit.userId} ` +
          `for match ${credit.matchId}`,
      );
    }
    outcomes.push({
      userId: credit.userId,
      refunded,
      telegramId: credit.telegramId,
      language: credit.language,
      platform: credit.platform,
    });
  }

  return outcomes;
}

/**
 * Plan + apply in one call — the one-liner for any path that kills a match in
 * its own transaction and still has the row afterwards (emergency
 * cancellation, and the scheduling-stall auto-cancel being built in parallel).
 *
 * Paths that delete or cancel the match inside a transaction whose commit also
 * removes it should instead `planMatchTicketRefunds(id, tx)` during the
 * transaction and `applyTicketRefunds(plan)` after it commits.
 */
export async function refundMatchTickets(matchId: string): Promise<TicketRefundOutcome[]> {
  const plan = await planMatchTicketRefunds(matchId);
  if (plan.length === 0) return [];
  return applyTicketRefunds(plan);
}

/** The localized "your ticket is back" line, or null when nothing was refunded. */
export function ticketRefundNoticeKey(
  refunded: number,
): "ticketRefundedToWallet" | "ticketRefundedToWalletBoth" | null {
  if (refunded <= 0) return null;
  return refunded === 1 ? "ticketRefundedToWallet" : "ticketRefundedToWalletBoth";
}
