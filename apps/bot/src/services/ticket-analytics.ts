/**
 * Date Ticket analytics events.
 *
 * v1 is a thin structured-logger hook with one call site per lifecycle moment
 * so the funnel (offer → intent → paid → both-paid / refunded) is observable
 * in the PM2 logs without a schema change. Persisting these to a dedicated
 * events table is a deliberate follow-up — keeping them out of
 * `MatchEventActionType` avoids a Prisma enum migration now (that enum is
 * scoped to Elo-affecting decision events).
 *
 * TODO: persist to an analytics table / sink when the dashboard needs ticket
 * funnel charts.
 */

export type TicketAnalyticsEvent =
  | "ticket_offer_sent"
  | "ticket_intent_created"
  | "ticket_paid"
  /// A slot settled by an active Gennety Premium subscription rather than by
  /// money or a wallet ticket (PRODUCT_SPEC §3.5b). Distinct from `ticket_paid`
  /// on purpose: it is the only way to measure whether the subscription is
  /// paying for the dates it covers, and a reader must be able to tell it from
  /// a gate that simply lapsed into free scheduling.
  | "premium_gate_settled"
  | "ticket_both_paid"
  | "ticket_refunded"
  // Famine single-ticket discount lifecycle (PRODUCT_SPEC §3.5b). Not tied to a
  // match (the store path has none), so `matchId` is optional and `userId`
  // identifies the subject instead.
  | "famine_discount_granted"
  | "famine_discount_redeemed";

export function emitTicketEvent(
  event: TicketAnalyticsEvent,
  props: {
    matchId?: string;
    userId?: string;
    side?: "A" | "B";
    scope?: "self" | "both" | "partner";
    amountCents?: number;
  },
): void {
  console.log(
    `[ticket-analytics] ${event}`,
    JSON.stringify({ event, ...props, at: new Date().toISOString() }),
  );
}
