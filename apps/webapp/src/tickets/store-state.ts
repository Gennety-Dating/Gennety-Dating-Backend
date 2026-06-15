/**
 * Pure, side-effect-free derivation for the ticket store Mini App — kept
 * independent of React/Telegram globals so it's unit-testable (see
 * store-state.test.ts). Bundle prices are inlined here (the webapp deliberately
 * does not depend on @gennety/shared); they must stay in sync with
 * `TICKET_BUNDLES` in packages/shared/src/constants.ts.
 */

export interface StoreBundleView {
  count: number;
  /** Total charged for the bundle, in cents. */
  priceCents: number;
  /** Per-ticket price, in cents (priceCents / count). */
  perTicketCents: number;
  /** True for the lowest per-ticket price — gets the "best value" treatment. */
  bestValue: boolean;
  /**
   * Whole-percent saving on the per-ticket price versus buying singles (the
   * count=1 bundle). 0 for the single bundle itself — the baseline gets no
   * savings badge.
   */
  discountPct: number;
}

const RAW_BUNDLES = [
  { count: 1, priceCents: 700 },
  { count: 3, priceCents: 1647 },
  { count: 6, priceCents: 2694 },
] as const;

export function storeBundles(): StoreBundleView[] {
  const withPer = RAW_BUNDLES.map((b) => ({
    ...b,
    perTicketCents: Math.round(b.priceCents / b.count),
  }));
  const cheapest = Math.min(...withPer.map((b) => b.perTicketCents));
  // Singles are the reference price the discount is measured against.
  const singlePerTicket = withPer.find((b) => b.count === 1)?.perTicketCents ?? cheapest;
  return withPer.map((b) => ({
    ...b,
    bestValue: b.perTicketCents === cheapest,
    discountPct:
      singlePerTicket > 0
        ? Math.round(((singlePerTicket - b.perTicketCents) / singlePerTicket) * 100)
        : 0,
  }));
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
