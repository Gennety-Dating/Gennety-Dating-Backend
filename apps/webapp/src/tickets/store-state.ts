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
  /**
   * Active "famine" single-ticket discount percent applied to THIS bundle's
   * price (only ever non-zero on the count=1 bundle). Drives the distinct
   * loyalty badge + the reduced single price. Must stay in sync with
   * `FAMINE_DISCOUNT_PCT` / the server's `discountedCents`.
   */
  famineDiscountPct: number;
}

const RAW_BUNDLES = [
  { count: 1, priceCents: 700 },
  { count: 3, priceCents: 1647 },
  { count: 6, priceCents: 2694 },
] as const;

/** Mirror of the server's `discountedCents` (services/ticket-discount.ts). */
function discounted(priceCents: number, pct: number): number {
  const clamped = Math.min(100, Math.max(0, pct));
  return Math.round((priceCents * (100 - clamped)) / 100);
}

/**
 * Build the store bundle views. `famineDiscountPct > 0` discounts the "1 ticket"
 * bundle only — the catalog best-value / savings math is computed on the
 * undiscounted catalog prices so the famine deal can't mislabel the 6-pack.
 */
export function storeBundles(famineDiscountPct = 0): StoreBundleView[] {
  const withPer = RAW_BUNDLES.map((b) => ({
    ...b,
    perTicketCents: Math.round(b.priceCents / b.count),
  }));
  const cheapest = Math.min(...withPer.map((b) => b.perTicketCents));
  // Singles are the reference price the discount is measured against.
  const singlePerTicket = withPer.find((b) => b.count === 1)?.perTicketCents ?? cheapest;
  return withPer.map((b) => {
    const famine = b.count === 1 && famineDiscountPct > 0 ? famineDiscountPct : 0;
    return {
      count: b.count,
      priceCents: famine ? discounted(b.priceCents, famine) : b.priceCents,
      perTicketCents: famine ? discounted(b.perTicketCents, famine) : b.perTicketCents,
      bestValue: b.perTicketCents === cheapest,
      discountPct:
        singlePerTicket > 0
          ? Math.round(((singlePerTicket - b.perTicketCents) / singlePerTicket) * 100)
          : 0,
      famineDiscountPct: famine,
    };
  });
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface StoreStarsBundleView {
  count: number;
  /** Total Stars (XTR) for the bundle. */
  stars: number;
  /** Per-ticket Stars (rounded, for display). */
  perTicketStars: number;
  /** True for the lowest per-ticket Star price. */
  bestValue: boolean;
  /** Whole-percent saving on per-ticket Stars vs the single bundle. */
  discountPct: number;
}

/**
 * Build the store bundle views priced in Telegram Stars from the server's
 * `bundleStars` map (`{ "1": 350, "3": 830, "6": 1350 }`). Mirrors the USD
 * `storeBundles` discount/best-value math, but on Star prices. Only the bundle
 * sizes present in the map are shown. The famine discount is USD-only, so it
 * never applies here.
 */
export function storeBundlesStars(
  bundleStars: Record<string, number> | null | undefined,
): StoreStarsBundleView[] {
  if (!bundleStars) return [];
  const items = [1, 3, 6]
    .map((count) => ({ count, stars: bundleStars[String(count)] }))
    .filter((b): b is { count: number; stars: number } => typeof b.stars === "number" && b.stars > 0)
    .map((b) => ({ ...b, perTicketStars: b.stars / b.count }));
  if (items.length === 0) return [];
  const cheapest = Math.min(...items.map((b) => b.perTicketStars));
  const single = items.find((b) => b.count === 1)?.perTicketStars ?? cheapest;
  return items.map((b) => ({
    count: b.count,
    stars: b.stars,
    perTicketStars: Math.round(b.perTicketStars),
    bestValue: b.perTicketStars === cheapest,
    discountPct: single > 0 ? Math.round(((single - b.perTicketStars) / single) * 100) : 0,
  }));
}

export function formatStars(stars: number): string {
  return `⭐${stars}`;
}
