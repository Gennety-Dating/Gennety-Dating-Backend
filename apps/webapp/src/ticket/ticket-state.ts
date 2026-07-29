import type { TicketState, TicketScope } from "../api.js";

/**
 * Pure derivation of the Date Ticket Mini App's current screen + the offer
 * buttons. Kept side-effect-free so it's unit-testable without React or the
 * Telegram globals (see ticket-state.test.ts).
 */

export type TicketScreen =
  | "offer" // my ticket isn't settled — show pay/use buttons
  | "cover-partner" // I'm a male who paid mine; partner unpaid — optionally cover them
  | "waiting" // I'm settled, partner hasn't — countdown
  | "success" // both paid (and I'm the one who acted) — confetti + scheduling
  | "partner-paid" // partner covered MY ticket (pay-for-both) — nothing to do
  | "closed"; // ticket refunded/expired — scheduling already opened free

export interface ScreenOptions {
  /**
   * The male tapped "let them grab it" on the cover screen. In-memory only (it
   * lives in React state for the session and is deliberately NOT persisted):
   * the cover screen leads with his OWN secured ticket, so being asked again on
   * a fresh open is no longer the pushy dead end it used to be.
   */
  coverDeferred?: boolean;
}

export function deriveScreen(state: TicketState, opts: ScreenOptions = {}): TicketScreen {
  if (
    state.ticketStatus === "refund_pending" ||
    state.ticketStatus === "refunded" ||
    state.ticketStatus === "expired"
  ) {
    return "closed";
  }
  // Partner-paid takes precedence over the generic success screen so the
  // covered user sees the dedicated "they paid for you ❤️" card.
  if (state.partnerPaidForMe) return "partner-paid";
  if (state.bothPaid) return "success";
  if (state.iPaid) {
    // A male who covered himself can still optionally cover his date instead of
    // just waiting for her to pay; everyone else waits. Declining the offer
    // drops him into the same "secured, waiting on them" screen a female gets —
    // before this he had NO way to reach it, so his own purchase never resolved
    // into a state of its own, only into another request for money.
    return state.myGender === "male" && !opts.coverDeferred ? "cover-partner" : "waiting";
  }
  return "offer";
}

export interface OfferButton {
  /**
   * "pay" = money (intent+confirm); "use" = spend from wallet balance;
   * "use-self-pay-partner" = spend 1 wallet ticket on the actor's own slot AND
   * pay the single per-ticket price for the partner's slot, in one tap (the
   * male, balance=1 "cover both" shortcut — strictly cheaper than paying the
   * doubled `both` price when he already holds a ticket).
   */
  action: "pay" | "use" | "use-self-pay-partner";
  scope: TicketScope;
  /** Charged amount for `pay`/combo buttons (cents); 0 for plain `use`. */
  amountCents: number;
  /** Tickets consumed for `use`/combo buttons; 0 for plain `pay`. */
  ticketCost: number;
  primary: boolean;
}

function pay(scope: TicketScope, amountCents: number, primary: boolean): OfferButton {
  return { action: "pay", scope, amountCents, ticketCost: 0, primary };
}
function use(scope: TicketScope, ticketCost: number, primary: boolean): OfferButton {
  return { action: "use", scope, amountCents: 0, ticketCost, primary };
}
/**
 * Male covering both with exactly one wallet ticket: the ticket pays his own
 * slot and a single-price (`price`, not `price * 2`) money charge covers the
 * partner's. So `ticketCost` is 1 AND `amountCents` is one ticket's price.
 */
function useSelfPayPartner(price: number, primary: boolean): OfferButton {
  return { action: "use-self-pay-partner", scope: "both", amountCents: price, ticketCost: 1, primary };
}

/**
 * Buttons for the initial "offer" screen (the actor's own ticket isn't settled
 * yet), balance-aware:
 *   female/unknown → use my ticket (if any) else pay my ticket
 *   male, balance≥2 → use 2 tickets (both) + use 1 (self)
 *   male, balance=1 → cover both (ticket for self + pay partner) + use 1 (self)
 *   male, balance=0 → pay for both + pay only mine
 * Unknown gender is treated as female — never offer pay/use-for-both without a
 * confirmed male gender (the server enforces this too).
 *
 * The covering option is ALWAYS the hero (the loud burgundy button — see the
 * `.btn-hero` ladder in ticket.css), whatever the balance. It used to invert at
 * exactly `balance === 1`, which is the single most common state a man reaches
 * this screen in: every new user is gifted one Date Ticket before their first
 * pitch, so the nudge was pointing the wrong way for most first-time payers.
 *
 * A male whose partner ALREADY settled her own slot has nothing left to cover,
 * so he is offered the `self` scope only. Without this he'd be shown "pay for
 * both" at the doubled price while `settleTicket` could only ever claim his one
 * remaining slot — i.e. a straight overcharge for a slot that doesn't exist.
 */
export function deriveOfferButtons(state: TicketState): OfferButton[] {
  const price = state.priceCents;
  // Famine discount applies to the actor's OWN ticket only (the `self` money
  // button). `both`/`partner` and the wallet combo keep full per-ticket price.
  const selfPrice = state.selfPriceCents;
  const canCover = state.myGender === "male" && !state.partnerPaid;
  if (canCover) {
    if (state.myBalance >= 2) {
      return [use("both", 2, true), use("self", 1, false)];
    }
    if (state.myBalance === 1) {
      return [useSelfPayPartner(price, true), use("self", 1, false)];
    }
    return [pay("both", price * 2, true), pay("self", selfPrice, false)];
  }
  if (state.myBalance >= 1) return [use("self", 1, true)];
  return [pay("self", selfPrice, true)];
}

/**
 * Buttons for the "cover-partner" screen — a male who already settled his own
 * ticket may optionally cover his date's ticket (with a wallet ticket or money)
 * or just wait for her to pay herself. The "just wait" alternative is rendered
 * as a real secondary button next to these (App.tsx) rather than a ghost text
 * link, and it moves him to the `waiting` screen instead of closing the app —
 * offering is the point, cornering him is not.
 */
export function deriveCoverPartnerButtons(state: TicketState): OfferButton[] {
  if (state.myBalance >= 1) {
    return [use("partner", 1, true), pay("partner", state.priceCents, false)];
  }
  return [pay("partner", state.priceCents, true)];
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Star price label, e.g. `350 ⭐`. */
export function formatStars(stars: number): string {
  return `${stars} ⭐`;
}

/**
 * Star price for an offer button. The `use-self-pay-partner` combo charges one
 * ticket's Stars (the partner's slot), so it maps to the `partner` price; every
 * other paid scope maps to its own price.
 */
export function starsForButton(
  b: OfferButton,
  stars: { self: number; both: number; partner: number },
): number {
  if (b.action === "use-self-pay-partner") return stars.partner;
  return stars[b.scope];
}

/** Whole milliseconds remaining until `expiresAt`, clamped at 0. */
export function msUntil(expiresAt: string | null, now: number = Date.now()): number {
  if (!expiresAt) return 0;
  return Math.max(0, new Date(expiresAt).getTime() - now);
}

/** Format a remaining-ms span as `Hh Mm` / `Mm` / `<1m`. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}
