import { describe, expect, it } from "vitest";
import { storeBundles, formatUsd } from "./store-state.js";

describe("storeBundles", () => {
  it("exposes the three documented bundles with per-ticket pricing", () => {
    const bundles = storeBundles();
    expect(bundles.map((b) => [b.count, b.priceCents, b.perTicketCents])).toEqual([
      [1, 700, 700],
      [3, 1647, 549],
      [6, 2694, 449],
    ]);
  });

  it("flags only the cheapest per-ticket bundle as best value", () => {
    const bundles = storeBundles();
    expect(bundles.filter((b) => b.bestValue).map((b) => b.count)).toEqual([6]);
  });

  it("derives the per-ticket saving vs singles (0 for the single bundle)", () => {
    const bundles = storeBundles();
    expect(bundles.map((b) => [b.count, b.discountPct])).toEqual([
      [1, 0],
      [3, 22],
      [6, 36],
    ]);
  });

  it("no famine discount by default", () => {
    expect(storeBundles().map((b) => b.famineDiscountPct)).toEqual([0, 0, 0]);
  });

  it("applies the famine discount to the single bundle only", () => {
    const bundles = storeBundles(77);
    const single = bundles.find((b) => b.count === 1)!;
    // 77% off $7.00 → $1.61.
    expect([single.priceCents, single.perTicketCents, single.famineDiscountPct]).toEqual([161, 161, 77]);
    // 3/6 bundles keep catalog price + no famine flag.
    expect(bundles.filter((b) => b.count !== 1).map((b) => [b.priceCents, b.famineDiscountPct])).toEqual([
      [1647, 0],
      [2694, 0],
    ]);
  });

  it("famine deal never steals best-value from the 6-pack", () => {
    const bundles = storeBundles(77);
    expect(bundles.filter((b) => b.bestValue).map((b) => b.count)).toEqual([6]);
  });
});

describe("formatUsd", () => {
  it("formats bundle totals", () => {
    expect(formatUsd(700)).toBe("$7.00");
    expect(formatUsd(1647)).toBe("$16.47");
    expect(formatUsd(2694)).toBe("$26.94");
  });
});
