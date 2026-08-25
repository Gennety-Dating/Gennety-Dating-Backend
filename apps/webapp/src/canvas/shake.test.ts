import { describe, expect, it, vi } from "vitest";

import {
  createShakeDetector,
  requestMotionPermission,
  shakeMagnitude,
  SHAKE_COOLDOWN_MS,
  SHAKE_MIN_SAMPLES,
  SHAKE_THRESHOLD,
  SHAKE_WINDOW_MS,
} from "./shake.js";

const GRAVITY = 9.81;

/** A phone lying still reads as gravity on one axis and nothing on the others. */
const still = (at: number) => ({ x: 0, y: 0, z: GRAVITY, at });
/** A reading well over the bar. */
const violent = (at: number) => ({ x: 0, y: 0, z: GRAVITY + SHAKE_THRESHOLD + 6, at });

describe("shakeMagnitude", () => {
  it("reads a resting phone as zero, whichever axis gravity is on", () => {
    expect(shakeMagnitude(still(0))).toBeCloseTo(0, 5);
    expect(shakeMagnitude({ x: GRAVITY, y: 0, z: 0, at: 0 })).toBeCloseTo(0, 5);
  });

  // Android browsers routinely deliver nulls on this event; treating them as
  // zero keeps a partial reading from registering as violent motion.
  it("survives null axes", () => {
    expect(shakeMagnitude({ x: null, y: null, z: null, at: 0 })).toBeCloseTo(GRAVITY, 5);
  });

  it("grows with the motion", () => {
    expect(shakeMagnitude(violent(0))).toBeGreaterThan(SHAKE_THRESHOLD);
  });
});

describe("createShakeDetector", () => {
  it("ignores a phone at rest forever", () => {
    const d = createShakeDetector();
    for (let i = 0; i < 50; i++) expect(d.feed(still(i * 20))).toBe(false);
  });

  // A phone put down hard clears any threshold worth having. What separates a
  // shake from a knock is that it repeats.
  it("does not fire on a single hard knock", () => {
    const d = createShakeDetector();
    expect(d.feed(violent(0))).toBe(false);
  });

  it("fires once the motion actually repeats", () => {
    const d = createShakeDetector();
    let fired = false;
    for (let i = 0; i < SHAKE_MIN_SAMPLES; i++) fired = d.feed(violent(i * 100));
    expect(fired).toBe(true);
  });

  it("does not accept samples spread across a longer window", () => {
    const d = createShakeDetector();
    for (let i = 0; i < SHAKE_MIN_SAMPLES + 2; i++) {
      expect(d.feed(violent(i * (SHAKE_WINDOW_MS + 50)))).toBe(false);
    }
  });

  // One continuous shake produces samples for as long as the hand moves; the
  // cooldown is what stops that becoming several posted bumps.
  it("fires once per shake, not once per sample", () => {
    const d = createShakeDetector();
    let fires = 0;
    for (let i = 0; i < 30; i++) if (d.feed(violent(i * 50))) fires++;
    expect(fires).toBe(1);
  });

  it("re-arms after the cooldown", () => {
    const d = createShakeDetector();
    for (let i = 0; i < SHAKE_MIN_SAMPLES; i++) d.feed(violent(i * 100));
    const base = SHAKE_COOLDOWN_MS + 1000;
    let fired = false;
    for (let i = 0; i < SHAKE_MIN_SAMPLES; i++) fired = d.feed(violent(base + i * 100));
    expect(fired).toBe(true);
  });

  it("forgets its history on reset", () => {
    const d = createShakeDetector();
    for (let i = 0; i < SHAKE_MIN_SAMPLES - 1; i++) d.feed(violent(i * 100));
    d.reset();
    expect(d.feed(violent(SHAKE_MIN_SAMPLES * 100))).toBe(false);
  });
});

describe("requestMotionPermission", () => {
  it("reports a browser with no motion event as unsupported, not denied", () => {
    // The two must stay distinct: one is a phone that cannot do this, the
    // other a phone that will once the user says so.
    return expect(requestMotionPermission(undefined)).resolves.toBe("unsupported");
  });

  it("treats a browser that never asks as already granted", async () => {
    await expect(requestMotionPermission({})).resolves.toBe("granted");
  });

  it("passes through an explicit grant and an explicit refusal", async () => {
    await expect(
      requestMotionPermission({ requestPermission: async () => "granted" }),
    ).resolves.toBe("granted");
    await expect(
      requestMotionPermission({ requestPermission: async () => "denied" }),
    ).resolves.toBe("denied");
  });

  // iOS throws when this is called outside a user gesture. Asking again from a
  // real tap is the fix, so "denied" is the honest answer — "unsupported"
  // would tell the user their phone cannot do something it can.
  it("reads a throw as denied rather than unsupported", async () => {
    const requestPermission = vi.fn(async () => {
      throw new Error("requires a user gesture");
    });
    await expect(requestMotionPermission({ requestPermission })).resolves.toBe("denied");
  });
});
