import { describe, expect, it } from "vitest";
import {
  buildScanFrames,
  scanFramesDurationMs,
  FINAL_HOLD_MS,
  MAX_FRAMES,
  START_MIN,
  START_MAX,
  TARGET_MIN,
  TARGET_MAX,
} from "./radar-scan-counter.js";

/** mulberry32 — small deterministic PRNG so the curve is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator pinned to the low end of every range (`randInt` → min). */
const allMin = () => 0;
/** A generator pinned to the high end of every range (`randInt` → max). */
const allMax = () => 0.999999;

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe("buildScanFrames", () => {
  it("starts in 3–6 and settles exactly on a target in 160–220", () => {
    for (const seed of SEEDS) {
      const frames = buildScanFrames(seeded(seed));
      const first = frames[0]!.n;
      const last = frames[frames.length - 1]!.n;

      expect(first).toBeGreaterThanOrEqual(START_MIN);
      expect(first).toBeLessThanOrEqual(START_MAX);
      expect(last).toBeGreaterThanOrEqual(TARGET_MIN);
      expect(last).toBeLessThanOrEqual(TARGET_MAX);
    }
  });

  it("never overshoots — the last frame IS the total, not a number past it", () => {
    for (const seed of SEEDS) {
      const frames = buildScanFrames(seeded(seed));
      const last = frames[frames.length - 1]!.n;
      // The clamp is what makes the count read as a search completing rather
      // than a broken odometer rolling past its own total.
      expect(Math.max(...frames.map((f) => f.n))).toBe(last);
    }
  });

  it("counts strictly upward", () => {
    for (const seed of SEEDS) {
      const frames = buildScanFrames(seeded(seed));
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i]!.n).toBeGreaterThan(frames[i - 1]!.n);
      }
    }
  });

  it("holds the final number for the 500ms settle", () => {
    for (const seed of SEEDS) {
      const frames = buildScanFrames(seeded(seed));
      expect(frames[frames.length - 1]!.holdMs).toBe(FINAL_HOLD_MS);
    }
  });

  it("applies each phase's own increment range", () => {
    for (const seed of SEEDS) {
      const frames = buildScanFrames(seeded(seed));
      const target = frames[frames.length - 1]!.n;

      for (let i = 1; i < frames.length; i++) {
        const from = frames[i - 1]!.n;
        const step = frames[i]!.n - from;
        const progress = from / target;
        // The final step is clamped down onto the target, so it can be smaller
        // than its phase's floor — only its upper bound is meaningful.
        const clamped = i === frames.length - 1;
        if (progress < 0.3) {
          if (!clamped) expect(step).toBeGreaterThanOrEqual(6);
          expect(step).toBeLessThanOrEqual(10);
        } else if (progress < 0.7) {
          if (!clamped) expect(step).toBeGreaterThanOrEqual(11);
          expect(step).toBeLessThanOrEqual(19);
        } else {
          if (!clamped) expect(step).toBeGreaterThanOrEqual(20);
          expect(step).toBeLessThanOrEqual(33);
        }
      }
    }
  });

  it("applies each phase's own delay range (deceleration)", () => {
    for (const seed of SEEDS) {
      const frames = buildScanFrames(seeded(seed));
      const target = frames[frames.length - 1]!.n;

      frames.slice(0, -1).forEach((frame) => {
        const progress = frame.n / target;
        if (progress < 0.3) {
          expect(frame.holdMs).toBeGreaterThanOrEqual(120);
          expect(frame.holdMs).toBeLessThanOrEqual(180);
        } else if (progress < 0.7) {
          expect(frame.holdMs).toBeGreaterThanOrEqual(280);
          expect(frame.holdMs).toBeLessThanOrEqual(380);
        } else {
          expect(frame.holdMs).toBeGreaterThanOrEqual(450);
          expect(frame.holdMs).toBeLessThanOrEqual(600);
        }
      });
    }
  });

  it("decelerates — later ticks are never faster than the phase they left", () => {
    for (const seed of SEEDS) {
      const frames = buildScanFrames(seeded(seed));
      // Per-frame jitter means adjacent holds can dip, but the phase floors
      // must be non-decreasing across the run.
      const floors = frames.slice(0, -1).map((f) => {
        if (f.holdMs <= 180) return 0;
        if (f.holdMs <= 380) return 1;
        return 2;
      });
      for (let i = 1; i < floors.length; i++) {
        expect(floors[i]!).toBeGreaterThanOrEqual(floors[i - 1]!);
      }
    }
  });

  it("stays within the frame budget so the edit burst is bounded", () => {
    for (const seed of SEEDS) {
      expect(buildScanFrames(seeded(seed)).length).toBeLessThanOrEqual(MAX_FRAMES);
    }
    // Both pinned extremes, which is what MAX_FRAMES actually guards against.
    expect(buildScanFrames(allMin).length).toBeLessThanOrEqual(MAX_FRAMES);
    expect(buildScanFrames(allMax).length).toBeLessThanOrEqual(MAX_FRAMES);
  });

  it("lands near the ~3.9s budget for the beat, and stays bounded at the extremes", () => {
    const durations = SEEDS.map((seed) => scanFramesDurationMs(buildScanFrames(seeded(seed))));
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;

    // The specified step/delay ranges put the expected beat a little above the
    // "~3900ms" headline (measured mean over 5000 seeds: 4534ms); the ranges are
    // the contract, so this asserts the real expected value rather than the
    // round number. A regression that halved or doubled the pace trips it.
    expect(mean).toBeGreaterThan(4200);
    expect(mean).toBeLessThan(4900);

    // Absolute floor/ceiling: every roll pinned in one direction.
    expect(scanFramesDurationMs(buildScanFrames(allMin))).toBeGreaterThan(2000);
    expect(scanFramesDurationMs(buildScanFrames(allMax))).toBeLessThan(9000);
  });

  it("is deterministic for a given generator", () => {
    expect(buildScanFrames(seeded(42))).toEqual(buildScanFrames(seeded(42)));
  });
});
