import { describe, expect, it } from "vitest";
import {
  HAPTIC_MIN_GAP_MS,
  WHEEL_ITEM_H,
  shouldTickHaptic,
  wheelValueAt,
} from "./onboarding-wheel.js";

describe("wheelValueAt", () => {
  it("reads the row centred under the capsule", () => {
    expect(wheelValueAt(0, 140, 220)).toBe(140);
    expect(wheelValueAt(WHEEL_ITEM_H, 140, 220)).toBe(141);
    expect(wheelValueAt(WHEEL_ITEM_H * 35, 140, 220)).toBe(175);
  });

  it("rounds to the nearer row mid-scroll", () => {
    expect(wheelValueAt(WHEEL_ITEM_H * 10.4, 140, 220)).toBe(150);
    expect(wheelValueAt(WHEEL_ITEM_H * 10.6, 140, 220)).toBe(151);
  });

  it("clamps rubber-banding past either end to a real value", () => {
    expect(wheelValueAt(-90, 140, 220)).toBe(140);
    expect(wheelValueAt(WHEEL_ITEM_H * 400, 140, 220)).toBe(220);
  });
});

describe("shouldTickHaptic", () => {
  it("stays silent while the same row is centred", () => {
    expect(shouldTickHaptic(175, 175, 0, 10_000)).toBe(false);
  });

  it("pulses when a row is crossed", () => {
    expect(shouldTickHaptic(175, 176, 0, 10_000)).toBe(true);
  });

  it("thins a fling that crosses rows faster than the floor", () => {
    const at = 10_000;
    expect(shouldTickHaptic(175, 176, at, at + HAPTIC_MIN_GAP_MS - 1)).toBe(false);
    expect(shouldTickHaptic(175, 176, at, at + HAPTIC_MIN_GAP_MS)).toBe(true);
  });

  it("still fires once the floor clears, since a suppressed row is not recorded", () => {
    // The caller leaves `ticked` at 175 when a pulse is dropped, so the very
    // next frame past the floor pulses for whatever is centred by then rather
    // than swallowing the crossing entirely.
    expect(shouldTickHaptic(175, 181, 10_000, 10_000 + HAPTIC_MIN_GAP_MS)).toBe(true);
  });
});
