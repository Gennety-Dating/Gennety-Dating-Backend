import { env } from "../config.js";

/**
 * Date Ticket purchase rails — which one a Telegram WebApp purchase settles on.
 *
 * Exactly ONE rail moves money in the Telegram product: **Telegram Stars**
 * (`TICKET_STARS_ENABLED=true`). The gate pays through
 * `POST /v1/matches/:id/ticket/stars-invoice` and the store through
 * `POST /v1/tickets/store/stars-invoice`; both mint a native Bot API invoice
 * (`createInvoiceLink`, empty provider token, currency `XTR`), and the bot
 * settles on `successful_payment` (`handlers/payments.ts`), re-validated in
 * `pre_checkout_query`. The server never takes a client's word that a payment
 * happened.
 *
 * The iOS app never reaches this module. It buys tickets with StoreKit
 * (`routes/tickets-appstore.ts`, verified against Apple) and spends them from
 * the wallet (`routes/ticket-gate.ts` → `/ticket-gate/use`): no web intent, no
 * card form, and no rail here for it to branch on.
 *
 * What used to live here and is gone (decision 2026-09-11): a
 * `TICKET_PAYMENT_MODE` switch between `mock` and a `stripe` branch that was
 * never implemented and threw on every call, plus an in-memory map of mock
 * "payment intents" that the server minted and then accepted back as proof of
 * payment.
 *
 * `no-charge` is what replaced the mock, and it is NOT a payment rail: it
 * settles without money, and only where no money can move — the investor demo
 * (whose isolation guard forbids Stars) and local development. It is decided
 * by the RUNTIME, never by a config default, so an incomplete production
 * `.env` cannot open it: production with Stars off gets `none`, and refuses to
 * boot in the first place (`assertPaymentTrustConfiguration`).
 */

/**
 * Which ticket(s) a single gate action settles:
 *   self    — the actor's own ticket (1 ticket)
 *   both    — the actor's + the partner's ticket in one action (2 tickets, male-only)
 *   partner — only the partner's ticket, after the actor already covered their
 *             own (1 ticket, male-only); lets a male with a single ticket use it
 *             for himself and still pay for his date afterwards.
 */
export type TicketScope = "self" | "both" | "partner";

export type TicketPurchaseRail =
  /** Native Telegram Stars invoice — the only rail that moves money. */
  | "stars"
  /** Settles without a charge. Demo and development runtimes only. */
  | "no-charge"
  /** Nothing can be bought: production with Stars off, which cannot boot. */
  | "none";

export interface TicketRailConfig {
  TICKET_STARS_ENABLED: boolean;
  DEMO_MODE_ENABLED: boolean;
}

/**
 * The rail a Telegram WebApp purchase settles on right now.
 *
 * Stars wins whenever it is on, including in development, so the real invoice
 * path can be exercised locally. The demo can never reach that branch —
 * `assertDemoIsolation()` refuses to boot a demo with Stars on.
 */
export function ticketPurchaseRail(
  config: TicketRailConfig = env,
  runtime: string | undefined = process.env.NODE_ENV,
): TicketPurchaseRail {
  if (config.TICKET_STARS_ENABLED) return "stars";
  if (config.DEMO_MODE_ENABLED) return "no-charge";
  if (runtime === "development" || runtime === "test") return "no-charge";
  return "none";
}

/** Number of tickets a scope settles (1 for self/partner, 2 for both). */
export function ticketsForScope(scope: TicketScope): number {
  return scope === "both" ? 2 : 1;
}

/** Cents a scope is priced at, for a given per-ticket price. */
export function amountForScope(scope: TicketScope, priceCents: number): number {
  return priceCents * ticketsForScope(scope);
}

/**
 * Telegram Stars (XTR) charged for a date-gate scope. The per-ticket Star
 * price is the 1-ticket store bundle entry (`TICKET_BUNDLE_STARS[1]`), so the
 * gate and the store stay in sync; `both` costs 2×. Used by the native
 * `WebApp.openInvoice` gate path (`POST /stars-invoice`) and re-validated in
 * the `pre_checkout_query` handler. Only meaningful when `TICKET_STARS_ENABLED`.
 */
export function gateStarsForScope(scope: TicketScope): number {
  const perTicket = env.TICKET_BUNDLE_STARS[1] ?? 0;
  return perTicket * ticketsForScope(scope);
}
