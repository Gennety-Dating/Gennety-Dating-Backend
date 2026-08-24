import { describe, it, expect } from "vitest";
import {
  PREMIUM_PLANS,
  DEFAULT_PREMIUM_PLAN_ID,
  premiumPlanById,
  premiumPlanStars,
  premiumPlanDiscountPct,
  premiumPlanDisplayPrice,
  premiumPlanPerMonthDisplay,
} from "./premium-plans.js";

/** The production monthly price at the time these expectations were written. */
const MONTHLY = 750;

describe("the plan catalog", () => {
  it("carries exactly the three products, cheapest first", () => {
    expect(PREMIUM_PLANS.map((p) => p.id)).toEqual(["monthly", "months3", "months6"]);
    expect(PREMIUM_PLANS.map((p) => p.months)).toEqual([1, 3, 6]);
  });

  it("only the monthly plan is a recurring Telegram subscription", () => {
    // Telegram supports a 30-day `subscription_period` and nothing else, so a
    // package MUST be a one-time invoice. Flipping this flips whether the
    // premium route asks Telegram to auto-renew it.
    expect(PREMIUM_PLANS.filter((p) => p.recurring).map((p) => p.id)).toEqual(["monthly"]);
  });

  it("resolves by id and refuses anything unknown", () => {
    expect(premiumPlanById("months6")?.months).toBe(6);
    expect(premiumPlanById("premium6")).toBeNull(); // that is the WIRE tag, not a plan id
    expect(premiumPlanById("months12")).toBeNull();
    expect(premiumPlanById("")).toBeNull();
    expect(premiumPlanById(null)).toBeNull();
    expect(premiumPlanById(undefined)).toBeNull();
  });

  it("defaults to monthly — what a client sending no plan means", () => {
    expect(premiumPlanById(DEFAULT_PREMIUM_PLAN_ID)?.months).toBe(1);
  });
});

describe("premiumPlanStars", () => {
  it("prices the monthly plan at exactly the configured price", () => {
    expect(premiumPlanStars(PREMIUM_PLANS[0], MONTHLY)).toBe(750);
  });

  it("applies 15% / 30% off the undiscounted block", () => {
    // 750×3 = 2250 → −15% = 1912.5 → 1912 (floored, see below)
    expect(premiumPlanStars(PREMIUM_PLANS[1], MONTHLY)).toBe(1912);
    // 750×6 = 4500 → −30% = 3150 exactly
    expect(premiumPlanStars(PREMIUM_PLANS[2], MONTHLY)).toBe(3150);
  });

  it("NEVER charges more than the advertised discount (rounds down)", () => {
    // The whole point of flooring: the button says "−15%", so the charge must
    // be at most 85% of the block. Rounding up would make that label a lie.
    for (const plan of PREMIUM_PLANS) {
      for (const monthly of [750, 749, 333, 101, 7, 1]) {
        const undiscounted = monthly * plan.months;
        const charged = premiumPlanStars(plan, monthly);
        expect(charged).toBeLessThanOrEqual(Math.ceil(undiscounted * (1 - plan.discount)));
        expect(charged).toBeLessThanOrEqual(undiscounted);
      }
    }
  });

  it("always yields a whole positive Star amount", () => {
    // Telegram rejects a zero/fractional invoice, and a misconfigured monthly
    // price must not turn into free Premium.
    for (const plan of PREMIUM_PLANS) {
      for (const monthly of [0, -5, 0.4, 1, 3]) {
        const stars = premiumPlanStars(plan, monthly);
        expect(Number.isInteger(stars)).toBe(true);
        expect(stars).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("keeps a longer package strictly cheaper per month", () => {
    // The ordering IS the offer. If it ever inverts, the picker is selling a
    // longer commitment at a worse rate.
    const perMonth = PREMIUM_PLANS.map((p) => premiumPlanStars(p, MONTHLY) / p.months);
    expect(perMonth[1]).toBeLessThan(perMonth[0]);
    expect(perMonth[2]).toBeLessThan(perMonth[1]);
  });
});

describe("display pricing", () => {
  it("reports the discount as whole percent", () => {
    expect(PREMIUM_PLANS.map(premiumPlanDiscountPct)).toEqual([0, 15, 30]);
  });

  it("scales the display price by the STAR ratio, not the raw discount", () => {
    // Derived from what is actually charged, so the floor above is reflected in
    // the label rather than contradicted by it: 1912/750 × 17.99 = 45.86…
    expect(premiumPlanDisplayPrice(PREMIUM_PLANS[0], MONTHLY, "$17.99")).toBe("$17.99");
    expect(premiumPlanDisplayPrice(PREMIUM_PLANS[1], MONTHLY, "$17.99")).toBe("$45.86");
    expect(premiumPlanDisplayPrice(PREMIUM_PLANS[2], MONTHLY, "$17.99")).toBe("$75.56");
  });

  it("preserves whatever currency decoration the config string carries", () => {
    expect(premiumPlanDisplayPrice(PREMIUM_PLANS[2], MONTHLY, "17.99 €")).toBe("75.56 €");
  });

  it("returns null rather than inventing a number", () => {
    expect(premiumPlanDisplayPrice(PREMIUM_PLANS[1], MONTHLY, "ask us")).toBeNull();
    expect(premiumPlanPerMonthDisplay(PREMIUM_PLANS[1], MONTHLY, "")).toBeNull();
  });

  it("computes an honest per-month figure for a package", () => {
    expect(premiumPlanPerMonthDisplay(PREMIUM_PLANS[1], MONTHLY, "$17.99")).toBe("$15.29");
    expect(premiumPlanPerMonthDisplay(PREMIUM_PLANS[2], MONTHLY, "$17.99")).toBe("$12.59");
  });
});
