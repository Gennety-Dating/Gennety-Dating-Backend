/**
 * What the Premium button says, and what the line under it says.
 *
 * This lives in its own module for one reason: `premium.ts` runs on import (it
 * calls `WebApp.ready()` and kicks off `load()`), so nothing in it can be unit
 * tested, and the rule below is one that must never quietly break.
 *
 * THE RULE. The button states a monthly RATE for every plan — that is the unit
 * the three cells are compared on since they stopped printing totals (§3.8), and
 * a button answering in a different unit than the control above it is how a
 * reader ends up believing they picked a different price. But a rate may be
 * unavailable: `premiumPlanPerMonthDisplay` returns null whenever the configured
 * price display has no parseable amount. A package must then fall back to its
 * total with NO suffix. "$75.56/mo" on the control that charges $75.56 once is
 * the one lie this screen cannot tell, and it is the exact shape the old
 * `buyPackage`-always branch existed to prevent.
 *
 * The monthly plan needs no fallback in either direction: its total IS its rate.
 */

/** The parts of a plan that decide the button's wording. */
export interface CtaPlan {
  /** True for the auto-renewing monthly plan, false for the 3/6-month packages. */
  recurring: boolean;
  /** Server-priced monthly rate, or null when it could not be derived. */
  perMonthDisplay: string | null;
}

/** The copy functions this needs — a structural subset of the screen's `Copy`. */
export interface CtaCopy {
  /** Appends a rate suffix ("— $15.29/mo"). Only ever given a real rate. */
  subscribe: (price: string) => string;
  /** States a total, suffix-free. The no-rate fallback for packages. */
  buyPackage: (price: string) => string;
  /** A package's terms line; carries the sum actually charged. */
  planOneOff: (total: string) => string;
  /** The recurring plan's terms line. */
  price: (rate: string) => string;
}

/**
 * The button's label. `total` is the plan's own display price (the sum charged),
 * and is used only where no rate exists or where the plan is billed once.
 */
export function ctaLabel(copy: CtaCopy, plan: CtaPlan | null, total: string): string {
  const rate = plan?.perMonthDisplay ?? null;
  if (rate) return copy.subscribe(rate);
  if (plan && !plan.recurring) return copy.buyPackage(total);
  return copy.subscribe(total);
}

/**
 * The line under the button. A package's total lives here now that the button
 * states a rate — this is the only place the amount actually charged is legible
 * before the invoice opens, so it is not decoration.
 */
export function ctaTerms(copy: CtaCopy, plan: CtaPlan | null, total: string): string {
  if (plan && !plan.recurring) return copy.planOneOff(total);
  return copy.price(plan?.perMonthDisplay ?? total);
}
