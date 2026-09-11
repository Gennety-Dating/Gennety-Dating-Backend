import { describe, expect, it } from "vitest";

import { SHAKE_THRESHOLD } from "../canvas/shake.js";
import { IMPULSE_MIN_GAP_MS, createImpulseGate } from "./kinetics.js";

const GRAVITY = 9.81;
/** A reading whose magnitude above resting gravity is `over` m/s², on the z axis. */
const reading = (over: number, at: number) => ({ x: 0, y: 0, z: GRAVITY + over, at });

describe("createImpulseGate", () => {
  it("fires once per swing, not once per reading over the bar", () => {
    const gate = createImpulseGate();
    const hits = [0, 16, 32, 48].map((at) => gate.feed(reading(SHAKE_THRESHOLD + 4, at)));
    expect(hits.filter(Boolean)).toHaveLength(1);
  });

  it("re-arms only after the hand swings back", () => {
    const gate = createImpulseGate();
    expect(gate.feed(reading(SHAKE_THRESHOLD + 2, 0))).not.toBeNull();
    // Still high: the same swing.
    expect(gate.feed(reading(SHAKE_THRESHOLD - 1, 50))).toBeNull();
    // Falls well under the bar — the reversal — then rises again.
    expect(gate.feed(reading(1, 150))).toBeNull();
    expect(gate.feed(reading(SHAKE_THRESHOLD + 2, 200))).not.toBeNull();
  });

  it("keeps a minimum gap between buzzes", () => {
    const gate = createImpulseGate();
    expect(gate.feed(reading(SHAKE_THRESHOLD + 2, 0))).not.toBeNull();
    gate.feed(reading(0, 20));
    expect(gate.feed(reading(SHAKE_THRESHOLD + 2, IMPULSE_MIN_GAP_MS - 10))).toBeNull();
    gate.feed(reading(0, IMPULSE_MIN_GAP_MS));
    expect(gate.feed(reading(SHAKE_THRESHOLD + 2, IMPULSE_MIN_GAP_MS + 30))).not.toBeNull();
  });

  it("ignores a phone lying still or set down gently", () => {
    const gate = createImpulseGate();
    expect(gate.feed(reading(0, 0))).toBeNull();
    expect(gate.feed(reading(SHAKE_THRESHOLD - 0.5, 20))).toBeNull();
  });

  it("scales the ripple with how hard the hand moved, capped at 1", () => {
    const soft = createImpulseGate().feed(reading(SHAKE_THRESHOLD, 0));
    const hard = createImpulseGate().feed(reading(SHAKE_THRESHOLD * 3, 0));
    expect(soft?.strength).toBeCloseTo(0.35, 2);
    expect(hard?.strength).toBe(1);
  });
});
