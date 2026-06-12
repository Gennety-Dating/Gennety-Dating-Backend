import { describe, expect, it } from "vitest";

import { typewriterLineHoldMs } from "./onboarding-timing.js";

describe("typewriterLineHoldMs", () => {
  it("keeps the existing hold for short lines", () => {
    expect(typewriterLineHoldMs(["x".repeat(49)], 1500)).toBe(1500);
  });

  it("holds long lines for 2.2 seconds", () => {
    expect(typewriterLineHoldMs(["x".repeat(50)], 1500)).toBe(2200);
  });

  it("does not shorten a longer scene-specific hold", () => {
    expect(typewriterLineHoldMs(["x".repeat(50)], 2400)).toBe(2400);
  });
});
