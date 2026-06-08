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
});

describe("formatUsd", () => {
  it("formats bundle totals", () => {
    expect(formatUsd(700)).toBe("$7.00");
    expect(formatUsd(1647)).toBe("$16.47");
    expect(formatUsd(2694)).toBe("$26.94");
  });
});
