import { describe, expect, it } from "vitest";

import {
  MONEY_BILLS,
  MONEY_LOOP_MS,
  MONEY_VIEW_MS,
  moneyBills,
} from "./onboarding-money.js";

describe("moneyBills", () => {
  it("is deterministic — the same geometry on every call", () => {
    expect(moneyBills()).toEqual(moneyBills());
    expect(MONEY_BILLS).toEqual(moneyBills());
  });

  it("stays sparse: this is a cost, not a jackpot shower", () => {
    // A shower reads as winning, which is the opposite of what the screen asks.
    expect(MONEY_BILLS.length).toBeGreaterThanOrEqual(10);
    expect(MONEY_BILLS.length).toBeLessThanOrEqual(18);
  });

  it("emits far layer first, so DOM order is paint order", () => {
    const layers = MONEY_BILLS.map((bill) => bill.layer);
    expect(layers).toEqual([...layers].sort((a, b) => a - b));
  });

  it("keeps every note inside the frame it was born in", () => {
    for (const bill of MONEY_BILLS) {
      expect(bill.xPct).toBeGreaterThan(0);
      expect(bill.xPct).toBeLessThan(100);
    }
  });

  it("blurs only the near layer — filter is the expensive one", () => {
    const blurred = MONEY_BILLS.filter((bill) => bill.blurPx > 0);
    expect(blurred.length).toBeLessThanOrEqual(3);
    expect(blurred.every((bill) => bill.layer === 2)).toBe(true);
  });

  it("gives every note a tumble, which is what makes it paper and not rubble", () => {
    // The screen one before this one drops icon tiles. Physics is the only
    // thing separating the two beats, so a note with no spin is a regression.
    for (const bill of MONEY_BILLS) {
      expect(bill.spinMs).toBeGreaterThan(0);
    }
  });

  it("starts each note mid-tumble, so they are never edge-on in unison", () => {
    for (const bill of MONEY_BILLS) {
      expect(bill.spinDelayMs).toBeLessThanOrEqual(0);
      expect(bill.spinDelayMs).toBeGreaterThan(-bill.spinMs);
    }
    const offsets = new Set(MONEY_BILLS.map((bill) => bill.spinDelayMs));
    expect(offsets.size).toBeGreaterThan(1);
  });

  it("spreads a layer across the width instead of clumping it", () => {
    for (const layer of [0, 1, 2] as const) {
      const xs = MONEY_BILLS.filter((bill) => bill.layer === layer)
        .map((bill) => bill.xPct)
        .sort((a, b) => a - b);
      expect(xs.length).toBeGreaterThan(0);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i] - xs[i - 1]).toBeGreaterThan(4);
      }
    }
  });
});

describe("the fall is already under way when the screen opens", () => {
  it("starts every note part-way down its own loop", () => {
    // A zero phase releases the whole layer from above the top edge together,
    // which fills the screen like a curtain and leaves the lower half empty
    // for the first second. Measured on the first build, not predicted.
    for (const bill of MONEY_BILLS) {
      expect(bill.phaseMs).toBeLessThan(0);
      expect(bill.phaseMs).toBeGreaterThan(-bill.durationMs);
    }
  });

  it("spreads a layer around its loop instead of leaving a lull", () => {
    for (const layer of [0, 1, 2] as const) {
      const progress = MONEY_BILLS.filter((bill) => bill.layer === layer)
        .map((bill) => -bill.phaseMs / bill.durationMs)
        .sort((a, b) => a - b);
      // No two notes of a layer sit on top of each other in the fall, and the
      // layer covers most of the drop rather than clustering at one height.
      for (let i = 1; i < progress.length; i += 1) {
        expect(progress[i] - progress[i - 1]).toBeGreaterThan(0.05);
      }
      expect(progress[progress.length - 1] - progress[0]).toBeGreaterThan(0.45);
    }
  });
});

describe("scene timing", () => {
  it("cuts away mid-fall", () => {
    // The notes are meant to still be coming down as the scene crossfades into
    // the stats screen — the one that answers this question.
    expect(MONEY_VIEW_MS).toBeLessThan(MONEY_LOOP_MS);
  });

  it("keeps the hold short enough not to stall the funnel", () => {
    // This is the whole of the scene's post-typing time now that the fall
    // starts with the screen rather than after the line lands: ~1.43s of typing
    // plus this, against the 2.04s bare hold the screen used to sit on. So the
    // money costs ~+0.36s, not the ~+0.9s the cued version did — and it is on
    // screen for all ~3.8s instead of the last 2.4. Onboarding drop-off is
    // watched; see deploy.md on the Type Radar pause.
    expect(MONEY_VIEW_MS).toBeLessThanOrEqual(2800);
  });
});
