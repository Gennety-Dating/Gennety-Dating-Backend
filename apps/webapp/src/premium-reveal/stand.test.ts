import { describe, expect, it } from "vitest";

import fixture from "./fixture.json";
import { beats, boxBlur3, edt2d, poseAt, T, timeline, WORD } from "./stand.js";

/**
 * Копия стенда против эталона, снятого с самого стенда
 * (`scripts/premium-reveal-fixtures.sh` в Gennety-iOS; тот же эталон держит
 * Swift-перенос — `PremiumRevealTests`). Поле надписи здесь не сверяется:
 * ему нужен холст с текстом, которого у vitest нет, — его код дословно тот
 * же, что у стенда, и сверяется съёмкой предпросмотра `?preview=reveal`.
 */

type PoseRow = number[];
const fx = fixture as unknown as {
  lastArrival: number;
  lastFocus: number;
  TL: { wordEnd: number; lightStart: number; copyIn: number; end: number };
  poses: PoseRow[];
};

describe("premium reveal — копия стенда", () => {
  const TL = timeline(fx.lastArrival, fx.lastFocus);

  it("такты — те же, что у стенда", () => {
    expect(TL.wordEnd).toBeCloseTo(fx.TL.wordEnd, 5);
    expect(TL.lightStart).toBeCloseTo(fx.TL.lightStart, 5);
    expect(TL.copyIn).toBeCloseTo(fx.TL.copyIn, 5);
    expect(TL.end).toBeCloseTo(fx.TL.end, 5);
  });

  it("кадры вне шейдера и свет — те же, что у стенда, с Reduce Motion и без", () => {
    for (const row of fx.poses) {
      const [t, rm, roll, ...want] = row;
      const P = poseAt(TL, t, rm > 0.5, roll);
      const got = [P.pwOut, P.copyK, P.doneK, P.blurOut, P.blurIn, P.blurDone, P.wordOpacity, P.wordT, P.rest, P.light];
      got.forEach((value, i) => {
        // Эталон округлён до 1e-6, кривые с наклоном до 6 его усиливают.
        expect(Math.abs(value - want[i]), `t=${t} rm=${rm} поле ${i}`).toBeLessThan(1e-4);
      });
    }
  });

  it("вибрации: капля на букву по нарастающей и застывание; под Reduce Motion — ни одной", () => {
    const list = beats(TL, WORD.length, false);
    expect(list).toHaveLength(WORD.length + 1);
    list.slice(0, WORD.length).forEach((b, i) => {
      expect(b.kind).toBe("drop");
      expect(b.t).toBeCloseTo(T.word + i * T.stagger, 9);
      expect(b.progress).toBeCloseTo((i + 1) / WORD.length, 9);
    });
    expect(list[WORD.length]).toEqual({ t: TL.wordEnd, kind: "settled", progress: 1 });
    expect(beats(TL, WORD.length, true)).toEqual([]);
  });

  it("расстояния Фельценшвальба совпадают с перебором", () => {
    const W = 13;
    const H = 9;
    const inside = (x: number, y: number): boolean => (x - 6) ** 2 / 16 + (y - 4) ** 2 / 6 <= 1;
    const g = new Float64Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = inside(x, y) ? 0 : 1e20;
    edt2d(g, W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let best = Infinity;
        for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) if (inside(u, v)) best = Math.min(best, (u - x) ** 2 + (v - y) ** 2);
        expect(g[y * W + x]).toBe(best);
      }
    }
  });

  it("размытие окном сохраняет постоянное поле и сглаживает ступень", () => {
    const W = 40;
    const H = 3;
    const flat = new Float32Array(W * H).fill(2.5);
    boxBlur3(flat, W, H, 4).forEach((v) => expect(v).toBeCloseTo(2.5, 5));
    const step = new Float32Array(W * H).map((_, i) => (i % W < W / 2 ? 0 : 1));
    const out = boxBlur3(step, W, H, 4);
    expect(out[W / 2]).toBeGreaterThan(0.3);
    expect(out[W / 2]).toBeLessThan(0.7);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[W - 1]).toBeCloseTo(1, 5);
  });
});
