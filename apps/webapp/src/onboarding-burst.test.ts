import { describe, expect, it } from "vitest";
import { BURST_SETS, type BurstTone, burstAt, flightAt } from "./onboarding-burst.js";

/**
 * Parameter count per SVG path command. `a` (arc) takes 7; `h`/`v` take 1;
 * `z` closes and takes none. A command may repeat its parameter set without
 * repeating the letter, so a valid run is any positive multiple of its arity.
 */
const ARITY: Record<string, number> = {
  m: 2, l: 2, t: 2,
  h: 1, v: 1,
  c: 6, s: 4, q: 4,
  a: 7,
  z: 0,
};

/** Splits a path into `[command, numbers[]]` runs, throwing on a stray token. */
function parsePath(d: string): Array<[string, number[]]> {
  const runs: Array<[string, number[]]> = [];
  // Commands are letters; numbers may carry a sign, a decimal point, or an
  // exponent, and may run together ("0-18", ".5.5") the way minified SVG does.
  const tokens = d.match(/[a-zA-Z]|[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  const rejoined = tokens.join("").replace(/\s/g, "");
  expect(rejoined, `unparsed characters in: ${d}`).toBe(d.replace(/[\s,]/g, ""));

  let command: string | null = null;
  let numbers: number[] = [];
  for (const token of tokens) {
    if (/[a-zA-Z]/.test(token)) {
      if (command) runs.push([command, numbers]);
      command = token;
      numbers = [];
    } else {
      expect(command, `path starts with a number: ${d}`).not.toBeNull();
      numbers.push(Number(token));
    }
  }
  if (command) runs.push([command, numbers]);
  return runs;
}

const TONES: BurstTone[] = ["male", "female", "neutral"];

describe("burst glyphs", () => {
  const glyphs = TONES.flatMap((tone) =>
    BURST_SETS[tone].glyphs.map((glyph, index) => ({ tone, index, glyph })),
  );

  it("draws something for every tone", () => {
    for (const tone of TONES) {
      expect(BURST_SETS[tone].glyphs.length, tone).toBeGreaterThanOrEqual(4);
      expect(BURST_SETS[tone].palette.length, tone).toBeGreaterThanOrEqual(2);
    }
  });

  // This is the guard that earns its keep: a hand-authored path with a
  // miscounted parameter run renders as garbage (or as nothing) with no error
  // anywhere, and the only other way to catch it is to look at all 40 of them.
  it("authors every path with a valid command run", () => {
    for (const { tone, index, glyph } of glyphs) {
      for (const d of [...glyph.d, ...(glyph.shade ?? [])]) {
        const where = `${tone}[${index}]: ${d.slice(0, 40)}…`;
        expect(d.trimStart().startsWith("M") || d.trimStart().startsWith("m"), where).toBe(true);

        for (const [command, numbers] of parsePath(d)) {
          const arity = ARITY[command.toLowerCase()];
          expect(arity, `${where} — unknown command "${command}"`).toBeDefined();
          if (arity === 0) {
            expect(numbers.length, `${where} — "${command}" takes no parameters`).toBe(0);
          } else {
            expect(numbers.length, `${where} — "${command}" run is not a multiple of ${arity}`)
              .toBeGreaterThan(0);
            expect(numbers.length % arity!, `${where} — "${command}" run of ${numbers.length}`)
              .toBe(0);
          }
        }
      }
    }
  });

  it("closes every subpath, so a filled shape can't bleed", () => {
    for (const { tone, index, glyph } of glyphs) {
      for (const d of [...glyph.d, ...(glyph.shade ?? [])]) {
        expect(/[zZ]\s*$/.test(d.trim()), `${tone}[${index}] is not closed`).toBe(true);
      }
    }
  });

  it("uses a viewBox of four numbers wherever one is overridden", () => {
    for (const { tone, index, glyph } of glyphs) {
      if (!glyph.box) continue;
      expect(glyph.box.trim().split(/[\s,]+/), `${tone}[${index}]`).toHaveLength(4);
    }
  });
});

describe("flightAt", () => {
  it("starts at the launch point", () => {
    expect(flightAt(500, -500, 0)).toEqual({ x: 0, y: 0 });
  });

  it("throws in the direction it was launched", () => {
    const up = flightAt(0, -600, 0.15);
    expect(up.y).toBeLessThan(0);
    const right = flightAt(600, 0, 0.15);
    expect(right.x).toBeGreaterThan(0);
  });

  it("lets gravity win: an upward throw comes back down", () => {
    const peak = flightAt(0, -600, 0.25);
    const later = flightAt(0, -600, 1.4);
    expect(peak.y).toBeLessThan(0);
    expect(later.y).toBeGreaterThan(peak.y);
  });

  it("settles sideways instead of drifting forever — that is what drag is for", () => {
    // Horizontal travel converges on v₀·τ, so the second half of the flight
    // covers far less ground than the first. A plain parabola would cover the
    // same distance in both halves and read as a tween.
    const early = flightAt(600, 0, 0.4).x;
    const late = flightAt(600, 0, 1.4).x - early;
    expect(late).toBeLessThan(early);
  });

  it("approaches terminal velocity rather than accelerating without limit", () => {
    const gravity = 1500;
    const tau = 0.4;
    const step = 0.05;
    const fallSpeed = (t: number): number =>
      (flightAt(0, 0, t + step, gravity, tau).y - flightAt(0, 0, t, gravity, tau).y) / step;
    expect(fallSpeed(2)).toBeLessThan(gravity * tau + 1);
    expect(fallSpeed(2)).toBeGreaterThan(gravity * tau - 10);
  });
});

describe("burstAt", () => {
  it("is a no-op without a DOM, so importing it can never break a screen", () => {
    expect(() => burstAt(10, 10, "male")).not.toThrow();
  });
});
