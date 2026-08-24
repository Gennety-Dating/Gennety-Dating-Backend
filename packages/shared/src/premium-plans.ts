/**
 * Gennety Premium purchase plans (PRODUCT_SPEC §3.8).
 *
 * Three ways to buy the SAME entitlement, differing only in how long a payment
 * buys and whether Telegram renews it:
 *
 *   • `monthly`  — the original RECURRING Telegram Stars subscription
 *                  (`subscription_period: 2592000`). Telegram charges again
 *                  every 30 days until the user cancels.
 *   • `months3`  — a ONE-TIME invoice buying 3 months, 15% off.
 *   • `months6`  — a ONE-TIME invoice buying 6 months, 30% off.
 *
 * The long packages are deliberately NOT subscriptions. Telegram supports only
 * a 30-day `subscription_period`, so "3 months, renewing" is not expressible as
 * a native Stars subscription at all — and a one-time purchase is also the
 * honest shape for a discounted block: the discount is the price of committing
 * to a fixed stretch, not a permanently cheaper rate. What replaces the renewal
 * is the expiry reminder (§3.8 → "Access is not silently lost"), which is why
 * these plans and that worker have to ship together: a package with no reminder
 * is access that vanishes without warning.
 *
 * ## Pricing is DERIVED, never a second set of numbers
 *
 * Every price is computed from the single monthly Star price (`PREMIUM_STARS`),
 * so a repricing is still one env change and the three plans can never drift
 * apart. This is the same rule PRODUCT_SPEC already states for
 * `PREMIUM_PRICE_USD_DISPLAY`: a second hand-maintained figure eventually
 * disagrees with what is actually charged.
 */

/** The plan a payment buys. Stable ids — they ride in the invoice payload. */
export type PremiumPlanId = "monthly" | "months3" | "months6";

export interface PremiumPlan {
  id: PremiumPlanId;
  /** Months of access this plan grants. */
  months: number;
  /**
   * Discount off `monthlyStars × months`, as a fraction in [0, 1).
   * `monthly` is the reference price and is therefore 0 by definition.
   */
  discount: number;
  /**
   * `true` → mint a recurring Telegram Stars subscription invoice;
   * `false` → mint an ordinary one-time invoice (no auto-renewal).
   */
  recurring: boolean;
}

/** Display order, cheapest first. The Mini App renders them in this order. */
export const PREMIUM_PLANS: readonly PremiumPlan[] = [
  { id: "monthly", months: 1, discount: 0, recurring: true },
  { id: "months3", months: 3, discount: 0.15, recurring: false },
  { id: "months6", months: 6, discount: 0.3, recurring: false },
] as const;

const PLANS_BY_ID = new Map<PremiumPlanId, PremiumPlan>(
  PREMIUM_PLANS.map((plan) => [plan.id, plan]),
);

/** The default plan — what an older client that sends no plan id means. */
export const DEFAULT_PREMIUM_PLAN_ID: PremiumPlanId = "monthly";

/**
 * Resolve a client-supplied plan id. Returns null for anything unknown, so a
 * tampered or future id can never be priced by accident — the caller decides
 * whether to refuse or fall back to the default.
 */
export function premiumPlanById(id: string | null | undefined): PremiumPlan | null {
  if (!id) return null;
  return PLANS_BY_ID.get(id as PremiumPlanId) ?? null;
}

/**
 * The Star price of a plan, derived from the monthly price.
 *
 * **Rounds DOWN, deliberately.** A fractional result (750 × 3 × 0.85 = 1912.5)
 * has to land on a whole Star, and the two directions are not equally safe:
 * rounding up charges slightly MORE than the advertised "15% off", i.e. it
 * makes the label on the button a lie, while rounding down means the user
 * always gets at least the discount promised. Same rule PRODUCT_SPEC applies
 * to `PREMIUM_PRICE_USD_DISPLAY` — never let the label under-state the charge.
 *
 * Floored at 1 Star: a zero-Star invoice is rejected by Telegram, and a
 * misconfigured `PREMIUM_STARS` must not turn into free Premium.
 */
export function premiumPlanStars(plan: PremiumPlan, monthlyStars: number): number {
  const base = Math.max(1, Math.trunc(monthlyStars));
  return Math.max(1, Math.floor(base * plan.months * (1 - plan.discount)));
}

/** The discount as whole percent, for display ("−15%"). */
export function premiumPlanDiscountPct(plan: PremiumPlan): number {
  return Math.round(plan.discount * 100);
}

/**
 * The plan's display price in the same currency as the monthly display string,
 * derived from the Star RATIO rather than from the discount.
 *
 * Deriving it from `planStars / monthlyStars` (not from `months × (1−discount)`)
 * is what keeps the label honest after the floor above: the label then tracks
 * exactly what is charged, including the fraction of a Star that rounding gave
 * back. Returns null when the monthly display string carries no number to scale
 * (the caller then shows the Star price alone rather than inventing one).
 */
export function premiumPlanDisplayPrice(
  plan: PremiumPlan,
  monthlyStars: number,
  monthlyDisplay: string,
): string | null {
  const match = /(\d+(?:[.,]\d+)?)/.exec(monthlyDisplay);
  if (!match) return null;
  const monthlyAmount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) return null;
  const base = Math.max(1, Math.trunc(monthlyStars));
  const scaled = (monthlyAmount * premiumPlanStars(plan, monthlyStars)) / base;
  // Keep the surrounding text (currency symbol / suffix) exactly as configured.
  return monthlyDisplay.replace(match[1], scaled.toFixed(2));
}

/** Per-month display price, for the "≈ $X/mo" line under a package. */
export function premiumPlanPerMonthDisplay(
  plan: PremiumPlan,
  monthlyStars: number,
  monthlyDisplay: string,
): string | null {
  const match = /(\d+(?:[.,]\d+)?)/.exec(monthlyDisplay);
  if (!match) return null;
  const monthlyAmount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) return null;
  const base = Math.max(1, Math.trunc(monthlyStars));
  const perMonth =
    (monthlyAmount * premiumPlanStars(plan, monthlyStars)) / (base * plan.months);
  return monthlyDisplay.replace(match[1], perMonth.toFixed(2));
}
