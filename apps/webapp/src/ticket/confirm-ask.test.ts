import { describe, expect, it } from "vitest";
import { ASK_GUARD_MS, ASK_HOLD_MS, canConfirm, shouldAutoClose } from "./confirm-ask.js";

describe("two-tap ask (parity with iOS TimeAcceptRow)", () => {
  it("uses the native guard and hold", () => {
    expect(ASK_GUARD_MS).toBe(350);
    expect(ASK_HOLD_MS).toBe(6000);
  });

  it("ignores the second half of a double tap", () => {
    expect(canConfirm(1000, 1000 + ASK_GUARD_MS - 1)).toBe(false);
    expect(canConfirm(1000, 1000 + ASK_GUARD_MS)).toBe(true);
  });

  it("never confirms a question that is not open", () => {
    expect(canConfirm(null, 99_999)).toBe(false);
  });

  it("folds an abandoned question back after the hold", () => {
    expect(shouldAutoClose(0, ASK_HOLD_MS - 1, false)).toBe(false);
    expect(shouldAutoClose(0, ASK_HOLD_MS, false)).toBe(true);
  });

  it("keeps the question open while a spend is in flight", () => {
    expect(shouldAutoClose(0, ASK_HOLD_MS * 3, true)).toBe(false);
  });
});
