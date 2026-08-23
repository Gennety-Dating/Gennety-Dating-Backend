import { describe, expect, it } from "vitest";
import {
  armGlove,
  BEATS,
  CARDS,
  cardX,
  CYC,
  FADE_MS,
  GREET_MS,
  handWork,
  isBehindBody,
  LOOP_FLOOR_MS,
  loopSway,
  MASCOT_BODY,
  mascotWelcomeMarkup,
  targetFor,
  track,
} from "./mascot-welcome.js";

// The webapp suite runs without a DOM, so everything here is a pure-function
// test: the rig's geometry and timing are exported precisely so they can be
// held to account away from a canvas. The mount path itself is verified by
// screenshot (`?preview=welcome:<phase>:<ms>` in dev).
//
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest tolerates it.
import CSS from "./onboarding.css?raw";

describe("body shape", () => {
  // The whole reason this module carries its own path: the shipped logo joins
  // its lower wings across a 4-unit bar (`L 52 65`), and the mascot converges
  // them on a point. If this ever picks the bar back up, the correction has
  // silently been lost.
  it("converges the lower wings on a single point", () => {
    expect(MASCOT_BODY).not.toMatch(/L\s+52\s+65/);
    expect(MASCOT_BODY).toContain("25 100, 50 65");
    expect(MASCOT_BODY).toContain("C 75 100");
  });

  it("is mirror-symmetric about x = 50", () => {
    const xs = [...MASCOT_BODY.matchAll(/(-?\d+)\s+(-?\d+)/g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThan(8);
    const mirrored = new Set(xs.map((x) => 100 - x));
    for (const x of xs) expect(mirrored.has(x), `no mirror for x=${x}`).toBe(true);
  });
});

describe("timing", () => {
  // Real added time on the onboarding funnel's very first screen. Pinned so it
  // cannot drift one retune at a time — the same treatment SUCCESS_TOTAL_MS
  // gets in butterfly-success.
  it("keeps the greeting inside its funnel budget", () => {
    expect(GREET_MS).toBeLessThanOrEqual(3800);
    expect(LOOP_FLOOR_MS).toBeLessThanOrEqual(1500);
    expect(FADE_MS).toBeLessThanOrEqual(300);
  });

  it("orders the beats and leaves room for the curtain", () => {
    const order = [
      BEATS.turn,
      BEATS.peer,
      BEATS.hold,
      BEATS.rock,
      BEATS.wink,
      BEATS.reach,
      BEATS.grip,
      BEATS.pull,
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!, `beat ${i} must follow beat ${i - 1}`).toBeGreaterThan(order[i - 1]!);
    }
    // The pull is the last beat, and the curtain has to actually cross the
    // stage afterwards — a pull that started too late would cut off mid-sweep.
    expect(GREET_MS - BEATS.pull).toBeGreaterThanOrEqual(800);
  });
});

describe("track", () => {
  it("holds flat outside its range and interpolates inside it", () => {
    const t = track([
      [100, 0],
      [200, 10],
    ]);
    expect(t(0)).toBe(0);
    expect(t(100)).toBe(0);
    expect(t(150)).toBeCloseTo(5, 5);
    expect(t(200)).toBe(10);
    expect(t(9999)).toBe(10);
  });
});

describe("the loop is seamless", () => {
  // The loop runs for however long /state takes, so every function it is built
  // from has to be periodic or continuous. A visible seam would land at a
  // different moment on every launch, which is the worst kind to debug.
  it("sways periodically", () => {
    for (const t of [0, 137, 611, 1200]) {
      expect(loopSway(t + 1400)).toBeCloseTo(loopSway(t), 6);
    }
  });

  it("streams cards periodically", () => {
    const card = CARDS[0]!;
    const period = 1000 / card.sp;
    expect(cardX(card, 500 + period)).toBeCloseTo(cardX(card, 500), 6);
  });

  it("moves hands continuously across a cycle boundary", () => {
    // A jump here is a hand teleporting mid-shuffle.
    for (const hand of [0, 1] as const) {
      for (let k = 1; k <= 6; k++) {
        const edge = k * CYC;
        const before = handWork(edge - 1, hand, 0);
        const after = handWork(edge + 1, hand, 0);
        const jump = Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1]);
        expect(jump, `hand ${hand} jumps ${jump.toFixed(1)} at ${edge}ms`).toBeLessThan(12);
      }
    }
  });
});

describe("card targeting", () => {
  // The predicate is imported rather than re-derived: a second copy of the
  // silhouette here could drift from the one the targeting actually uses and
  // the test would then be checking nothing.
  it("knows the middle of the body from the space beside it", () => {
    expect(isBehindBody(50, 50)).toBe(true);
    expect(isBehindBody(40, 68), "under the lower-left wing").toBe(true);
    expect(isBehindBody(10, 66), "beside the body, where a hand rests").toBe(false);
    expect(isBehindBody(90, 66)).toBe(false);
  });

  // A card passing behind the silhouette cannot be believably grabbed: the arm
  // would cross the logo, which reads as a hand on his own head.
  it("never books a card behind the body", () => {
    for (let t = 0; t < 4000; t += 17) {
      for (const hand of [0, 1] as const) {
        const target = targetFor(hand, t);
        if (target.miss) continue;
        const [x, y] = target.pos;
        expect(isBehindBody(x, y), `hand ${hand} booked (${x.toFixed(0)},${y.toFixed(0)}) at ${t}ms`).toBe(
          false,
        );
      }
    }
  });

  it("never books a card above the top wing", () => {
    for (let t = 0; t < 4000; t += 17) {
      for (const hand of [0, 1] as const) {
        const target = targetFor(hand, t);
        if (!target.miss) expect(target.pos[1]).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it("never books the same card in both hands", () => {
    let contested = 0;
    for (let t = 0; t < 4000; t += CYC) {
      const l = targetFor(0, t);
      const r = targetFor(1, t);
      if (!l.miss && !r.miss && l.card === r.card) contested++;
    }
    expect(contested).toBe(0);
  });

  it("hovers rather than lunging when nothing is in reach", () => {
    // A miss must still put the hand somewhere sane — beside the body, not at
    // the origin or off-stage.
    let misses = 0;
    for (let t = 0; t < 6000; t += 11) {
      for (const hand of [0, 1] as const) {
        const target = targetFor(hand, t);
        if (!target.miss) continue;
        misses++;
        expect(target.card).toBe(-1);
        expect(Math.abs(target.pos[0] - (hand === 0 ? 16 : 84))).toBeLessThan(6);
        expect(Math.abs(target.pos[1] - 66)).toBeLessThan(6);
      }
    }
    expect(misses, "the miss branch is never exercised — the test proves nothing").toBeGreaterThan(0);
  });
});

describe("the glove is oriented by the arm", () => {
  // This is the defect the whole rig was rebuilt around: a constant angle made
  // the hand read as a sticker dragged across the screen. The cuff must point
  // back along the arm, so the angle has to MOVE with the hand.
  it("points the cuff back down a straight arm", () => {
    // Hand directly below the shoulder, no bend: the cuff faces straight up
    // the way it came, i.e. 180° in this rig's convention.
    const straightDown = armGlove([50, 30], [50, 80], 0);
    expect(Math.abs(straightDown.ang)).toBeCloseTo(180, 0);

    // Hand directly right of the shoulder: the cuff faces back left, 90°.
    const straightRight = armGlove([30, 50], [90, 50], 0);
    expect(straightRight.ang).toBeCloseTo(90, 0);
  });

  it("turns the cuff as the hand moves", () => {
    const a = armGlove([34, 68], [12, 76], 13).ang;
    const b = armGlove([34, 68], [40, 30], 13).ang;
    expect(Math.abs(a - b)).toBeGreaterThan(40);
  });

  it("thins the band as the arm stretches", () => {
    const near = armGlove([34, 68], [40, 74], 0).d;
    const far = armGlove([34, 68], [140, 50], 0).d;
    const spread = (d: string): number => {
      const ys = [...d.matchAll(/-?[\d.]+ (-?[\d.]+)/g)].map((m) => Number(m[1]));
      return Math.max(...ys) - Math.min(...ys);
    };
    // Both bands are measured across their own thickness at the shoulder end;
    // the stretched one must be the thinner of the two.
    expect(spread(far) / Math.hypot(140 - 34, 50 - 68)).toBeLessThan(
      spread(near) / Math.hypot(40 - 34, 74 - 68),
    );
  });

  it("returns a closed filled path, not a stroke", () => {
    const { d } = armGlove([34, 68], [12, 76], 13);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
    expect(d).not.toContain("NaN");
  });
});

describe("markup", () => {
  it("announces itself and hides the drawing", () => {
    const html = mascotWelcomeMarkup("Синхронизация");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Синхронизация"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
  });

  it("escapes the label", () => {
    const html = mascotWelcomeMarkup('Rock & <b>roll</b> "now"');
    expect(html).toContain("Rock &amp; &lt;b&gt;roll&lt;/b&gt; &quot;now&quot;");
    expect(html).not.toContain("<b>roll</b>");
  });

  it("paints the ground far outside the viewBox", () => {
    // The SVG is fitted with `meet`, so on a tall phone there are letterbox
    // bands above and below the stage that still have to read as the page.
    const html = mascotWelcomeMarkup("x");
    const bg = /class="mw-bg" x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)"/.exec(html);
    expect(bg, "no background rect").not.toBeNull();
    const [x, y, w, h] = bg!.slice(1).map(Number) as [number, number, number, number];
    expect(x).toBeLessThan(-50);
    expect(y).toBeLessThan(-28);
    expect(x + w).toBeGreaterThan(150);
    expect(y + h).toBeGreaterThan(128);
  });

  it("carries one card group per card", () => {
    const html = mascotWelcomeMarkup("x");
    expect([...html.matchAll(/class="mw-card-g"/g)]).toHaveLength(CARDS.length);
  });
});

describe("stylesheet", () => {
  function rule(selector: string): string {
    const at = CSS.indexOf(selector);
    expect(at, `${selector} missing from onboarding.css`).toBeGreaterThan(-1);
    const open = CSS.indexOf("{", at);
    return CSS.slice(open + 1, CSS.indexOf("}", open)).replace(/\/\*[\s\S]*?\*\//g, "");
  }

  // The curtain works by NOT painting right of its edge, so anything that
  // paints the overlay's own box covers the screen it exists to reveal. This
  // is the one rule that cannot be relaxed.
  it("never gives the overlay wrapper a background", () => {
    expect(rule(".mw {")).not.toMatch(/background/);
  });

  it("keeps the stage's own ground painted from a token", () => {
    expect(rule(".mw-bg {")).toMatch(/fill:\s*var\(--bg\)/);
  });

  // The eyes sit inside the body, ringed by burgundy. The gloves float outside
  // it and touch the page directly, so on cream they vanish without this.
  it("gives the gloves depth on the light theme", () => {
    const at = CSS.indexOf('[data-theme="light"] .mw-gloves');
    expect(at, "no light-theme glove rule").toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf("}", at));
    expect(block).toMatch(/drop-shadow/);
    expect(block, "depth comes from shadow, never an outline").not.toMatch(/border|outline/);
  });

  // Darkening reads as unlit on both themes; a page-coloured wash would
  // lighten the body on cream, which reads as the opposite.
  it("shades the turned-away side with a fixed dark tint", () => {
    expect(rule(".mw-shade {")).not.toMatch(/var\(--bg\)/);
    expect(rule(".mw-shade {")).toMatch(/#3b0b1e/i);
  });

  // Content outside the viewBox has to paint into the letterbox bands, which
  // is also why the grab hand needs its own fade rather than a clip.
  it("lets the stage paint outside its box", () => {
    expect(rule(".mw-svg {")).toMatch(/overflow:\s*visible/);
  });
});
