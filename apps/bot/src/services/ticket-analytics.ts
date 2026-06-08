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
  | "ticket_both_paid"
  | "ticket_refunded";

export function emitTicketEvent(
  event: TicketAnalyticsEvent,
  props: {
    matchId: string;
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
