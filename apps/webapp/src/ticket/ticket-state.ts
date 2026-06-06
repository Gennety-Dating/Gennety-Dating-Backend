import type { TicketState, TicketScope } from "../api.js";

/**
 * Pure derivation of the Date Ticket Mini App's current screen + the offer
 * buttons. Kept side-effect-free so it's unit-testable without React or the
 * Telegram globals (see ticket-state.test.ts).
 */

export type TicketScreen =
  | "offer" // nobody (relevant) paid yet — show pay buttons
  | "waiting" // I paid, partner hasn't — countdown
  | "success" // both paid (and I'm the one who acted) — confetti + scheduling
  | "partner-paid" // partner covered MY ticket (pay-for-both) — nothing to do
  | "closed"; // ticket refunded/expired — scheduling already opened free

export function deriveScreen(state: TicketState): TicketScreen {
  if (state.ticketStatus === "refunded" || state.ticketStatus === "expired") return "closed";
  // Partner-paid takes precedence over the generic success screen so the
  // covered user sees the dedicated "they paid for you ❤️" card.
  if (state.partnerPaidForMe) return "partner-paid";
  if (state.bothPaid) return "success";
  if (state.iPaid) return "waiting";
  return "offer";
}

export interface OfferButton {
  scope: TicketScope;
  amountCents: number;
  primary: boolean;
}

/**
 * Offer buttons by gender:
 *   male   → "pay for both" ($13.98, primary) + "pay only mine" ($6.99)
 *   female → single "pay my ticket" ($6.99)
 * Unknown gender is treated as female (single self-pay) — never offer
 * pay-for-both without a confirmed male gender (the server enforces this too).
 */
export function deriveOfferButtons(state: TicketState): OfferButton[] {
  const self: OfferButton = { scope: "self", amountCents: state.priceCents, primary: true };
  if (state.myGender === "male") {
    return [
      { scope: "both", amountCents: state.priceCents * 2, primary: true },
      { ...self, primary: false },
    ];
  }
  return [self];
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
