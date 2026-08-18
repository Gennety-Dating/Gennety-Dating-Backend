import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest runs it happily.
// Non-empty only because vite.config.ts lists this stylesheet in
// `test.css.include` — vitest stubs CSS imports otherwise.
import CSS from "./onboarding.css?raw";

/**
 * The soft keyboard is the one thing on screen this app does not control, and
 * making room for it is the one motion that has to look like it belongs to the
 * keyboard rather than to us. Two properties are worth holding:
 *
 *  1. Every surface that shrinks by `--kb-height` uses the SAME curve. A screen
 *     that eased differently from the gate one step before it would read as two
 *     different keyboards.
 *  2. The curve cannot regress to one that dumps most of the travel into a
 *     couple of frames. That is what the founder reported as the Continue pill
 *     jumping up and dropping back: `cubic-bezier(0.22, 1, 0.36, 1)` leaves at
 *     4.55x its own average speed (1 / 0.22) and, measured on the real render at
 *     a 336px keyboard, moved 115px in ONE frame — a third of the way in 16ms.
 */

/** A `cubic-bezier(a, b, c, d)` value, as authored. */
function controlPoints(value: string): [number, number, number, number] {
  const m = /cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(value);
  if (!m) throw new Error(`not a cubic-bezier: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** One `--name: value;` declaration out of the stylesheet. */
function customProperty(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  if (!m) throw new Error(`no --${name} in the stylesheet`);
  return m[1]!.trim();
}

/** Eased progress at time fraction `x`, by bisecting the bezier's x axis. */
function progress([x1, y1, x2, y2]: [number, number, number, number], x: number): number {
  const at = (a: number, b: number, t: number): number =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return at(y1, y2, (lo + hi) / 2);
}

/** Largest share of the travel any single 60Hz frame carries. */
function worstFrameShare(points: [number, number, number, number], durationMs: number): number {
  const frame = 1000 / 60;
  let worst = 0;
  let prev = 0;
  for (let t = frame; t <= durationMs + frame; t += frame) {
    const now = progress(points, Math.min(1, t / durationMs));
    worst = Math.max(worst, now - prev);
    prev = now;
  }
  return worst;
}

const EASE = customProperty("kb-ease");
const DURATION = Number(/(\d+)ms/.exec(customProperty("kb-ease-ms"))![1]);

describe("the shared keyboard-following curve", () => {
  it("does not launch faster than it travels", () => {
    const [x1, y1] = controlPoints(EASE);
    // y1 / x1 is the curve's slope at t=0, in multiples of its own average
    // speed. The curve this replaced sat at 4.55x, which is the whole defect.
    const launch = x1 === 0 ? 0 : y1 / x1;
    expect(launch).toBeLessThanOrEqual(1.2);
  });

  it("keeps every single frame under an eighth of the travel", () => {
    // At the 336px keyboard the report was filed against, 12.5% is 42px in a
    // frame. The old curve was 34.3% — 115px, measured on the real render.
    expect(worstFrameShare(controlPoints(EASE), DURATION)).toBeLessThan(0.125);
  });

  it("stays close to the time the OS spends animating the keyboard", () => {
    // iOS animates it in ~250ms. Much shorter and the pill arrives before the
    // keyboard; much longer and it trails behind it.
    expect(DURATION).toBeGreaterThanOrEqual(200);
    expect(DURATION).toBeLessThanOrEqual(320);
  });

  it("is the only curve any keyboard-driven shrink uses", () => {
    // Every rule that reads --kb-height and transitions because of it must go
    // through the token, so the profile screens and the gates cannot drift into
    // two different keyboards.
    const shrinking = [...CSS.matchAll(/transition:\s*(height|max-height)\s*([^;]+);/g)];
    expect(shrinking.length).toBeGreaterThanOrEqual(3);
    for (const [, property, rest] of shrinking) {
      expect(rest, `transition: ${property} ${rest}`).toContain("var(--kb-ease-ms)");
      expect(rest, `transition: ${property} ${rest}`).toContain("var(--kb-ease)");
    }
  });
});
