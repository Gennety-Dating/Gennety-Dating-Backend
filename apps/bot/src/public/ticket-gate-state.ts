import { env } from "../config.js";

/**
 * Which §3.5b ticket-gate screen a side owes, derived from the match row.
 *
 * Its own module rather than a private helper in `matches-service.ts` purely
 * so it can be tested as the pure function it is — that file's import graph
 * reaches the whole Express server.
 */

/** The subset of `Match` columns this decision reads. */
export interface TicketGateColumns {
  ticketStatus: string;
  ticketExpiresAt: Date | null;
  paidForPartnerByA: boolean;
  paidForPartnerByB: boolean;
  partnerPaidSeenAt: Date | null;
}

/**
 * - `open`    — the gate is blocking this pair's Calendar; show the gate.
 * - `reveal`  — settled, and the partner covered THIS side's ticket without
 *               them having seen it yet. The server is deliberately holding
 *               their Calendar back until they do (`skipSide` in
 *               `completeTicketGateAndUnlockScheduling`), so a client that
 *               routed them straight to planning would strand them on a screen
 *               with nothing on it.
 * - `none`    — nothing to show: feature off, never armed, or already done.
 *
 * **`ticketStatus` alone cannot answer this.** It defaults to `"pending"` on
 * every row the table has ever held, so a match created before the feature
 * existed reads identically to one whose gate is genuinely open.
 * `ticketExpiresAt` is the column `sendTicketOffer` actually stamps, and the
 * one both completion and expiry clear, so *it* is the armed marker.
 */
export function ticketGateFor(
  match: TicketGateColumns,
  side: "A" | "B",
): "none" | "open" | "reveal" {
  if (!env.TICKET_FEATURE_ENABLED) return "none";
  const open =
    match.ticketExpiresAt !== null &&
    (match.ticketStatus === "pending" || match.ticketStatus === "partial");
  if (open) return "open";
  const iWasCovered = side === "A" ? match.paidForPartnerByB : match.paidForPartnerByA;
  if (match.ticketStatus === "completed" && iWasCovered && match.partnerPaidSeenAt === null) {
    return "reveal";
  }
  return "none";
}
