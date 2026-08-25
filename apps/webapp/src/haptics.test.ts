import { describe, expect, it } from "vitest";
import {
  boundaryEvent,
  rheostatStyle,
  SCALE_MIN_GAP_MS,
  shouldTickScale,
} from "./haptics";

describe("rheostatStyle", () => {
  it("runs from dull to sharp across the scale", () => {
    expect(rheostatStyle(1, 10)).toBe("soft");
    expect(rheostatStyle(5, 10)).toBe("light");
    expect(rheostatStyle(10, 10)).toBe("rigid");
  });

  it("is monotonic — a weight never gets lighter as the level rises", () => {
    const order: Record<string, number> = { soft: 0, light: 1, rigid: 2 };
    let previous = -1;
    for (let level = 1; level <= 10; level += 1) {
      const weight = order[rheostatStyle(level, 10)];
      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
  });

  it("gives the maximum no special case", () => {
    // The feedback form is the only place the product learns whether a date
    // worked. A haptic that rewards a 10 would bias that dataset by finger,
    // so the top of the scale is just the top of the ramp.
    expect(rheostatStyle(10, 10)).toBe(rheostatStyle(9, 10));
  });

  it("clamps out-of-range levels and survives a one-notch scale", () => {
    expect(rheostatStyle(0, 10)).toBe("soft");
    expect(rheostatStyle(99, 10)).toBe("rigid");
    expect(rheostatStyle(1, 1)).toBe("soft");
  });
});

describe("shouldTickScale", () => {
  it("suppresses ticks inside the gap and allows them after it", () => {
    expect(shouldTickScale(1_000, 1_000 + SCALE_MIN_GAP_MS - 1)).toBe(false);
    expect(shouldTickScale(1_000, 1_000 + SCALE_MIN_GAP_MS)).toBe(true);
  });
});

describe("boundaryEvent", () => {
  it("stays silent on the first evaluation", () => {
    // The map may open on a restored draft that is already outside the market;
    // bumping there would report a crossing that never happened.
    expect(boundaryEvent(null, false)).toBe("none");
    expect(boundaryEvent(null, true)).toBe("none");
  });

  it("fires only on a crossing, not while the pin rests outside", () => {
    expect(boundaryEvent(true, false)).toBe("exit");
    expect(boundaryEvent(false, true)).toBe("enter");
    expect(boundaryEvent(false, false)).toBe("none");
    expect(boundaryEvent(true, true)).toBe("none");
  });
});
