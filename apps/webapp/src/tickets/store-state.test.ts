import { describe, expect, it } from "vitest";
import { storeBundles, formatUsd } from "./store-state.js";

describe("storeBundles", () => {
  it("exposes the three documented bundles with per-ticket pricing", () => {
    const bundles = storeBundles();
    expect(bundles.map((b) => [b.count, b.priceCents, b.perTicketCents])).toEqual([
      [1, 849, 849],
      [3, 2037, 679],
      [6, 3312, 552],
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
      [3, 20],
      [6, 35],
    ]);
  });

  it("no famine discount by default", () => {
    expect(storeBundles().map((b) => b.famineDiscountPct)).toEqual([0, 0, 0]);
  });

  it("applies the famine discount to the single bundle only", () => {
    const bundles = storeBundles(77);
    const single = bundles.find((b) => b.count === 1)!;
    // 77% off $8.49 → $1.95.
    expect([single.priceCents, single.perTicketCents, single.famineDiscountPct]).toEqual([195, 195, 77]);
    // 3/6 bundles keep catalog price + no famine flag.
    expect(bundles.filter((b) => b.count !== 1).map((b) => [b.priceCents, b.famineDiscountPct])).toEqual([
      [2037, 0],
      [3312, 0],
    ]);
  });

  it("famine deal never steals best-value from the 6-pack", () => {
    const bundles = storeBundles(77);
    expect(bundles.filter((b) => b.bestValue).map((b) => b.count)).toEqual([6]);
  });
});

describe("formatUsd", () => {
  it("formats bundle totals", () => {
    expect(formatUsd(849)).toBe("$8.49");
    expect(formatUsd(2037)).toBe("$20.37");
    expect(formatUsd(3312)).toBe("$33.12");
  });
});
