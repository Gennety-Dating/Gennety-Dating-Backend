import { prisma } from "@gennety/db";
import { ACCOUNT_DELETION_REFUND_DEFER_DAYS } from "@gennety/shared";
import { PRIME_PURCHASE_PROCESSING, PRIME_PURCHASE_REFUND_FAILED } from "./prime-time-purchase.js";
import {
  VENUE_PURCHASE_PROCESSING,
  VENUE_PURCHASE_REFUND_FAILED,
} from "./venue-change-refund.js";

/**
 * Refunds a sweep still owns for one account — the question account deletion
 * has to ask before it erases anything (A13-H14).
 *
 * Payment rows outlive a deleted account (`onDelete: SetNull`), but the thing a
 * Stars refund is SENT to — the payer's Telegram id — lives on the user row and
 * goes with it. Every refund sweep reads it through the relation, so a row whose
 * owner is gone is a refund nothing can ever complete. Hence: while one of these
 * is young, deletion is deferred and the person is asked to retry; once it is
 * older than `ACCOUNT_DELETION_REFUND_DEFER_DAYS`, it has been failing for a
 * week, deletion goes ahead and the founder receives the ids.
 *
 * What counts, per table, and why:
 *   - `ticket_ledger`: `gate_payment` (a Stars charge not yet settled — the
 *     sweep refunds it if it stays that way), `gate_processing` (inside the
 *     settle transaction; listed so a state that ever becomes durable is not
 *     missed) and `gate_refund_pending` (the refund call failed and is retried).
 *     The reasons are private constants of `handlers/matching/ticket-gate.ts`.
 *     `gate_surplus_pending` is deliberately absent: it owes a WALLET credit,
 *     and the wallet is erased with the account either way.
 *   - `rematch_purchases` / `venue_change_purchases` / `prime_time_purchases`:
 *     `processing` (Stars moved, settle not recorded) and `refund_failed`. The
 *     Rematch pair is spelled out rather than imported from `rematch.ts`, which
 *     would pull the whole matching engine into the deletion path for two
 *     strings (`REMATCH_PROCESSING` / `REMATCH_REFUND_FAILED`).
 *     `refund_manual` (the App Store venue-change dead end) is not a sweep's —
 *     Apple refunds the buyer on their own request, with no server call.
 *   - `matches.ticket_status = 'refund_pending'` on a match of this account:
 *     the ticket-expiry rail is mid-refund. The match row cascades with EITHER
 *     participant, so deleting takes the refund promise with it whichever side
 *     paid. A match carries no refund timestamp, so its age is `updatedAt` —
 *     later than the claim when anything else touched the row, which errs
 *     toward deferring.
 * A charge only ever lives on these rows, so an account with none of them has
 * no money in flight.
 */

const STARS_GATE_IN_FLIGHT_REASONS = ["gate_payment", "gate_processing", "gate_refund_pending"];
const PURCHASE_IN_FLIGHT_STATUSES = {
  rematch_purchases: ["processing", "refund_failed"],
  venue_change_purchases: [VENUE_PURCHASE_PROCESSING, VENUE_PURCHASE_REFUND_FAILED],
  prime_time_purchases: [PRIME_PURCHASE_PROCESSING, PRIME_PURCHASE_REFUND_FAILED],
} as const;

export interface RefundInFlightRow {
  table:
    | "ticket_ledger"
    | "rematch_purchases"
    | "venue_change_purchases"
    | "prime_time_purchases"
    | "matches";
  id: string;
  /** The row's own status / reason / ticket status. */
  status: string;
  /** When the refund's clock started: `createdAt`, or `updatedAt` for a match. */
  since: Date;
}

export interface RefundsInFlight {
  /** Young enough to defer the deletion. */
  blocking: RefundInFlightRow[];
  /** Older than the defer window — reported to the founder, not blocking. */
  stale: RefundInFlightRow[];
}

type RefundInFlightDb = Pick<
  typeof prisma,
  "ticketLedger" | "rematchPurchase" | "venueChangePurchase" | "primeTimePurchase" | "match"
>;

export async function findRefundsInFlight(
  userId: string,
  db: RefundInFlightDb = prisma,
  now: Date = new Date(),
): Promise<RefundsInFlight> {
  const [ledger, rematch, venue, prime, matches] = await Promise.all([
    db.ticketLedger.findMany({
      where: {
        userId,
        externalPaymentId: { not: null },
        reason: { in: STARS_GATE_IN_FLIGHT_REASONS },
      },
      select: { id: true, reason: true, createdAt: true },
    }),
    db.rematchPurchase.findMany({
      where: { userId, status: { in: [...PURCHASE_IN_FLIGHT_STATUSES.rematch_purchases] } },
      select: { id: true, status: true, createdAt: true },
    }),
    db.venueChangePurchase.findMany({
      where: { userId, status: { in: [...PURCHASE_IN_FLIGHT_STATUSES.venue_change_purchases] } },
      select: { id: true, status: true, createdAt: true },
    }),
    db.primeTimePurchase.findMany({
      where: { userId, status: { in: [...PURCHASE_IN_FLIGHT_STATUSES.prime_time_purchases] } },
      select: { id: true, status: true, createdAt: true },
    }),
    db.match.findMany({
      where: {
        ticketStatus: "refund_pending",
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      select: { id: true, ticketStatus: true, updatedAt: true },
    }),
  ]);

  const rows: RefundInFlightRow[] = [
    ...ledger.map((row) => ({
      table: "ticket_ledger" as const,
      id: row.id,
      status: row.reason,
      since: row.createdAt,
    })),
    ...rematch.map((row) => ({
      table: "rematch_purchases" as const,
      id: row.id,
      status: row.status,
      since: row.createdAt,
    })),
    ...venue.map((row) => ({
      table: "venue_change_purchases" as const,
      id: row.id,
      status: row.status,
      since: row.createdAt,
    })),
    ...prime.map((row) => ({
      table: "prime_time_purchases" as const,
      id: row.id,
      status: row.status,
      since: row.createdAt,
    })),
    ...matches.map((row) => ({
      table: "matches" as const,
      id: row.id,
      status: row.ticketStatus,
      since: row.updatedAt,
    })),
  ];

  const cutoff = now.getTime() - ACCOUNT_DELETION_REFUND_DEFER_DAYS * 24 * 60 * 60 * 1000;
  return {
    blocking: rows.filter((row) => row.since.getTime() >= cutoff),
    stale: rows.filter((row) => row.since.getTime() < cutoff),
  };
}
