import { describe, expect, it } from "vitest";

import fixture from "./fixtures/ceremony-parity.json";
import { Ceremony, type CeremonyFrame, type CeremonyRole } from "./ceremony-stand.js";
import {
  STAND_LABELS,
  dueHaptics,
  hapticsFor,
  localizeFrame,
  ownDevice,
  planFor,
} from "./adapter.js";

/**
 * The vendored stand against the iOS repo's reference numbers.
 *
 * `fixtures/ceremony-parity.json` is a subset of the fixture the Swift port is
 * held to (`scripts/mascot-ceremony-fixtures.mjs` in Gennety-iOS). The layout
 * of each frame row is that script's `frameOf`. The planning goes through
 * `planFor(ownDevice(…))` — the path a Telegram phone takes — so this also
 * proves that describing a phone by `{ w, h, mm, home }` alone changes nothing
 * in the frame math.
 */

interface FixtureFrame {
  t: number;
  frame: {
    stage: number;
    blur: number;
    capsule: number[] | null;
    plaque: number[] | null;
    mascot: number[] | null;
  };
}

interface FixtureConfig {
  name: string;
  device: { width: number; height: number; mmPerPoint: number; home: number };
  role: CeremonyRole;
  reduceMotion: boolean;
  markDX: number;
  layout: number[];
  beats: number[];
  haptics: [string, number][];
  frames: FixtureFrame[];
}

const configs = (fixture as unknown as { configs: FixtureConfig[] }).configs;
const TOL = 1e-4;
const LABEL: Record<string, number> = { "": 0, [STAND_LABELS.waiting]: 1, [STAND_LABELS.ready]: 2 };

function rowOf(f: CeremonyFrame): FixtureFrame["frame"] {
  const c = f.capsule;
  const q = f.plaque;
  const m = f.mascot;
  return {
    stage: f.stage,
    blur: f.blur,
    capsule: c
      ? [c.x, c.y, c.w, c.h, c.alpha ?? 1, LABEL[c.label ?? ""] ?? -1, c.labelAlpha ?? 1, c.waiting ? 1 : 0]
      : null,
    plaque: q ? [q.x, q.y, q.w, q.h, q.alpha, q.text, q.mark ?? 1, q.markX] : null,
    mascot: m
      ? [
          m.C[0], m.C[1], m.s, m.sx, m.sy, m.e.alpha, m.blur || 0,
          m.e.tilt, m.e.anchor, m.e.flexL, m.e.flexR,
          m.e.eyes.gx, m.e.eyes.gy, m.e.eyes.blinkL, m.e.eyes.blinkR, m.e.eyes.smileL, m.e.eyes.smileR,
          m.e.sparkle, m.e.sparkleP || 0, m.e.toMark || 0,
        ]
      : null,
  };
}

function close(actual: number[] | null, expected: number[] | null, where: string): void {
  if (expected === null) {
    expect(actual, where).toBeNull();
    return;
  }
  expect(actual, where).not.toBeNull();
  expect(actual!.length, where).toBe(expected.length);
  expected.forEach((v, i) => {
    expect(Math.abs(actual![i]! - v), `${where}[${i}] = ${actual![i]} vs ${v}`).toBeLessThanOrEqual(TOL);
  });
}

describe("the vendored ceremony reproduces the stand", () => {
  expect(configs.length).toBeGreaterThanOrEqual(3);

  for (const c of configs) {
    it(`${c.name}: layout, beats, haptics and ${c.frames.length} frames`, () => {
      const device = ownDevice({ w: c.device.width, h: c.device.height, home: c.device.home, mm: c.device.mmPerPoint });
      const P = planFor(device, { rm: c.reduceMotion, markDX: c.markDX });
      const L = P[c.role].L;
      close([L.capY, L.capW, L.capH, L.foot, L.apex], c.layout, `${c.name} layout`);
      close(
        [P.b.leap, P.t1, P.t2, P.t3, P.b.glance, P.b.wink, P.b.dissolve, P.b.plaque, P.tEnd],
        c.beats,
        `${c.name} beats`,
      );
      expect(hapticsFor(P, c.role).map((h) => h.id)).toEqual(c.haptics.map(([id]) => id));
      close(
        hapticsFor(P, c.role).map((h) => h.t),
        c.haptics.map(([, t]) => t),
        `${c.name} haptic times`,
      );
      for (const { t, frame } of c.frames) {
        const row = rowOf(Ceremony.frame(P, c.role, t));
        const where = `${c.name} t=${t}`;
        close([row.stage, row.blur], [frame.stage, frame.blur], `${where} stage`);
        close(row.capsule, frame.capsule, `${where} capsule`);
        close(row.plaque, frame.plaque, `${where} plaque`);
        close(row.mascot, frame.mascot, `${where} mascot`);
      }
    });
  }

  it("leaves the stand's device table as it found it", () => {
    const before = Object.keys(Ceremony.DEVICES).sort();
    planFor(ownDevice({ w: 390, h: 844, home: 34 }), { rm: false, markDX: -96 });
    expect(Object.keys(Ceremony.DEVICES).sort()).toEqual(before);
  });
});

describe("the capsule where the terminal has it", () => {
  const device = ownDevice({ w: 390, h: 844, home: 34 });

  it("moves the capsule and keeps the stand's foot distance under it", () => {
    const stand = planFor(device, { rm: false, markDX: -96 });
    const moved = planFor(device, { rm: false, markDX: -96, capY: 760 });
    const gap = stand.A.L.foot - stand.A.L.capY;
    for (const P of [moved.A, moved.B]) {
      expect(P.L.capY).toBe(760);
      expect(P.L.foot - P.L.capY).toBeCloseTo(gap, 9);
      expect(P.L.apex).toBe(stand.A.L.apex);
      expect(P.L.capW).toBe(stand.A.L.capW);
    }
  });

  it("draws the scene from there: the capsule, the plaque and the landing", () => {
    const P = planFor(device, { rm: false, markDX: -96, capY: 760 });
    expect(Ceremony.frame(P, "A", -10).capsule?.y).toBe(760);
    expect(Ceremony.frame(P, "B", P.tEnd).plaque?.y).toBe(760);
    // B lands with its body centred on the capsule line, as on the stand.
    const landed = Ceremony.frame(P, "B", P.t3 + 800).mascot!;
    const standLanded = Ceremony.frame(planFor(device, { rm: false, markDX: -96 }), "B", P.t3 + 800).mascot!;
    expect(landed.C[1] - 760).toBeCloseTo(standLanded.C[1] - planFor(device, { rm: false, markDX: -96 }).B.L.capY, 6);
  });
});

describe("labels and haptics", () => {
  const P = planFor(ownDevice({ w: 390, h: 844, home: 34 }), { rm: false, markDX: -96 });
  const labels = { waiting: "Waiting for your date…", ready: "Ready", title: "Meeting confirmed", sub: "Next ticket's on me" };

  it("swaps the stand's Russian demo strings for the terminal's", () => {
    expect(localizeFrame(Ceremony.frame(P, "A", -50), labels).capsule?.label).toBe(labels.waiting);
    expect(localizeFrame(Ceremony.frame(P, "B", -50), labels).capsule?.label).toBe(labels.ready);
    const end = localizeFrame(Ceremony.frame(P, "A", P.tEnd), labels).plaque!;
    expect([end.title, end.sub]).toEqual([labels.title, labels.sub]);
  });

  it("buzzes each role's own beats once, and never for a beat long gone", () => {
    const a = hapticsFor(P, "A");
    const b = hapticsFor(P, "B");
    expect(a.map((h) => h.id)).toEqual(["ceremonyLaunch", "success"]);
    expect(b.map((h) => h.id)).toEqual(["magSafeSnap"]);
    expect(dueHaptics(a, P.b.leap - 16, P.b.leap)).toEqual(["ceremonyLaunch"]);
    expect(dueHaptics(a, P.b.leap, P.b.leap + 16)).toEqual([]);
    // Joined 2 s late: the launch is history, nothing buzzes for it.
    expect(dueHaptics(a, P.b.leap + 2000, P.b.leap + 2016)).toEqual([]);
    expect(dueHaptics(b, P.t3 - 1000, P.t3 + 100)).toEqual(["magSafeSnap"]);
    expect(dueHaptics(b, P.t3 - 1000, P.t3 + 900)).toEqual([]);
  });
});
