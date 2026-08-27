import { describe, expect, it } from "vitest";
import {
  armGlove,
  examineAt,
  HELD_SCALE,
  gScaleX,
  gripPoint,
  handScale,
  BEATS,
  CARDS,
  cardX,
  cardFade,
  CYC,
  FADE_MS,
  GREET_MS,
  HAND_PHASE_R,
  handWork,
  isBehindBody,
  LOOP_FLOOR_MS,
  loopSway,
  MASCOT_BODY,
  mascotWelcomeMarkup,
  PHASE,
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
  // Both ceilings were raised on 2026-08-23 (3800 / 1500) when the gesture
  // became a real pick-up rather than a tap: a grab takes 1400ms now, so a
  // 1400ms floor showed less than one of them, and the turn was stretched from
  // 162ms to 470. That is ~1.5s more on the funnel's first screen, once per
  // user — a deliberate cost, which is exactly why it is pinned rather than
  // left to drift one retune at a time.
  //
  // The floor was raised again on 2026-08-26, 2000 -> 4000, because three
  // examinations do not read as "working THROUGH profiles" (founder). Same
  // treatment: a stated decision with a ceiling, not drift. It is a floor
  // against the `/state` fetch rather than an addition, so the worst case is
  // the whole two seconds and the typical case is close to it.
  it("keeps the greeting inside its funnel budget", () => {
    expect(GREET_MS).toBeLessThanOrEqual(4800);
    expect(LOOP_FLOOR_MS).toBeLessThanOrEqual(4200);
    expect(FADE_MS).toBeLessThanOrEqual(300);
  });

  // The number the founder actually asked for, measured rather than asserted:
  // "хотя бы где-то четыре штуки пересмотрел". At 2000ms it was three, which
  // is what prompted it; the arithmetic said two, so this counts the real
  // thing. Sampling both hands over the floor and counting the cycles that
  // reach a genuine examination is the only way the requirement survives a
  // retune of CYC, of the phase offset, or of the floor itself.
  it("shows at least four profiles examined before the turn", () => {
    const seen = new Set<string>();
    for (let t = 0; t <= LOOP_FLOOR_MS; t += 8) {
      for (const [hand, off] of [
        [0, 0],
        [1, HAND_PHASE_R],
      ] as const) {
        const state = handWork(t, hand as 0 | 1, off);
        if (state.lift >= 0.9 && state.card >= 0) {
          seen.add(`${hand}:${Math.floor(t / CYC + (hand === 1 ? HAND_PHASE_R : 0))}`);
        }
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  // The floor exists so the turn interrupts something. Below one gesture there
  // is nothing to interrupt — the mascot would be caught mid-reach.
  it("holds the loop for at least a whole gesture", () => {
    expect(LOOP_FLOOR_MS).toBeGreaterThanOrEqual(CYC);
  });

  it("gives the turn enough frames to read as a rotation", () => {
    // It was 80ms, which at 60Hz is five frames from full-face to edge-on —
    // the eye reads that as a cut, and it was reported as exactly that.
    expect(BEATS.turn).toBeGreaterThanOrEqual(220);
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

  it("dissolves a card in and out instead of popping it", () => {
    // The seam this closes: a flat opacity meant a card MATERIALISED at its
    // spawn point and was cut in half by the curtain clip on the way out.
    // Invisible on a phone (the viewBox fills the width, so both events are
    // off-screen) and plainly visible in a browser, where `meet` leaves
    // letterbox either side and `.mw-svg` is `overflow: visible`.
    expect(cardFade(-78)).toBe(0);
    expect(cardFade(-64)).toBeGreaterThan(0.2);
    expect(cardFade(-64)).toBeLessThan(0.8);
    expect(cardFade(160)).toBe(0);
  });

  // The load-bearing half: the ramps ARE the off-viewBox margins. If either
  // one reached inside the band, a phone — where the band is the whole screen
  // — would start dissolving cards in mid-air, which is worse than the browser
  // seam being fixed.
  it("never fades a card while it is still on a phone's screen", () => {
    for (let x = -50; x <= 150; x += 0.5) {
      expect(cardFade(x), `faded to ${cardFade(x).toFixed(3)} at x=${x}`).toBe(1);
    }
  });

  // The clip and the ramp's end are one number in the module. If they ever
  // stop being one number, this is what says so: a card still visible where
  // nothing is painted is a card cut in half.
  it("has nothing left to cut by the time the curtain clips it", () => {
    let worst = 0;
    for (const card of CARDS) {
      for (let t = 0; t < 30000; t += 4) {
        const x = cardX(card, t);
        if (x > 159.5) worst = Math.max(worst, cardFade(x));
      }
    }
    expect(worst).toBeLessThan(0.02);
  });

  // Eased, not linear — the rule the gender screen's photo fade already
  // states: a two-stop linear ramp has a visible kink where it begins, and the
  // eye reads that line as the edge of the thing being faded.
  it("eases both ramps rather than ramping them linearly", () => {
    for (const [a, b] of [
      [-78, -50],
      [150, 160],
    ] as const) {
      const mid = cardFade((a + b) / 2);
      const quarter = cardFade(a + (b - a) * 0.25);
      const linear = 0.25;
      expect(mid).toBeCloseTo(0.5, 2);
      // A cubic smoothstep sits well under its own straight line at a quarter.
      expect(Math.abs(quarter - (a < 0 ? linear : 1 - linear))).toBeGreaterThan(0.08);
    }
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

  // He MAY reach above his own head — that is an ordinary thing to do, and it
  // is what makes seven of the nine cards reachable instead of five. What he
  // may not do is reach off the top of the stage after a card that is only
  // half on it. (The silhouette is the neighbouring test's job; this one is
  // purely about the frame.)
  it("never books a card off the top of the stage", () => {
    for (let t = 0; t < 4000; t += 17) {
      for (const hand of [0, 1] as const) {
        const target = targetFor(hand, t);
        if (!target.miss) expect(target.pos[1]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  // At BOOKING granularity. The instant-level version — no two hands holding
  // one card at any moment — lives with the gesture tests below, and is the
  // one that actually matters now that a hand keeps its card for most of a
  // cycle. Both are kept: this one fails loudly if the exclusion set is
  // dropped, without depending on the phase layout.
  it("never books the same card in both hands", () => {
    let contested = 0;
    let booked = 0;
    for (let k = 0; k < 24; k++) {
      const l = targetFor(0, (k + PHASE.reach) * CYC);
      const r = targetFor(1, (k + PHASE.reach) * CYC);
      if (l.miss || r.miss) continue;
      booked++;
      if (l.card === r.card) contested++;
    }
    expect(booked, "neither hand ever books — the test proves nothing").toBeGreaterThan(8);
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

describe("the hand's axis comes from the arm", () => {
  // The angle used to rotate a five-fingered glove, and a constant one made
  // the hand read as a sticker dragged across the screen. The hand is a circle
  // now, so the angle only aims its squash — but it still has to MOVE with the
  // hand, or a hand reaching sideways would flatten vertically.
  it("points back down a straight arm", () => {
    // Hand directly below the shoulder, no bend: local +Y faces straight up
    // the way it came, i.e. 180° in this rig's convention.
    const straightDown = armGlove([50, 30], [50, 80], 0);
    expect(Math.abs(straightDown.ang)).toBeCloseTo(180, 0);

    // Hand directly right of the shoulder: it faces back left, 90°.
    const straightRight = armGlove([30, 50], [90, 50], 0);
    expect(straightRight.ang).toBeCloseTo(90, 0);
  });

  it("turns the axis as the hand moves", () => {
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

  // He is turned away from us, so a card held up to read is between him and
  // whatever he is facing — his back occludes it. Painted in front he slid
  // across his own silhouette in 20% of held frames, covering up to 40% of the
  // card with himself, which is what "карточки просвечиваются через него" was
  // (founder, 2026-08-26). Two orderings carry the fix and neither is
  // arbitrary: the body must be over the card, and the arms must stay UNDER it
  // — the bottom-outer grip was chosen so the arm runs along the card's lower
  // edge and reads end to end, and putting the card behind the arms would trade
  // one occlusion complaint for another.
  it("keeps a held card behind his back and above his arms", () => {
    const html = mascotWelcomeMarkup("x");
    expect(html.indexOf('class="mw-held"'), "his back must occlude the card").toBeLessThan(
      html.indexOf('class="mw-body"'),
    );
    expect(html.indexOf('class="mw-held"'), "the arm must not be drawn over the card").toBeGreaterThan(
      html.indexOf('class="mw-arms"'),
    );
    // And the stream sits behind the body too, so the grab and the release do
    // not jump a card from one side of him to the other.
    expect(html.indexOf('class="mw-cards"')).toBeLessThan(html.indexOf('class="mw-body"'));
  });

  // The other half of putting the card behind him: he may occlude it on the way
  // out and on the way back, but never while he is READING it. The examine spot
  // sits clear of the silhouette today (0% covered on average, 8% worst), and
  // this is what says so if it is ever moved inward — a card he is holding up
  // to look at that is 40% behind his own back is the complaint, one phase
  // later.
  it("never hides the card he is actually reading", () => {
    const inBody = (x: number, y: number): boolean =>
      ((x - 50) / 35) ** 2 + ((y - 50) / 27) ** 2 < 1;
    let worst = 0;
    for (let t = 0; t <= LOOP_FLOOR_MS; t += 8) {
      for (const [hand, off] of [
        [0, 0],
        [1, HAND_PHASE_R],
      ] as const) {
        const st = handWork(t, hand as 0 | 1, off);
        if (!st.hold || st.card < 0 || st.lift < 0.9) continue;
        const card = CARDS[st.card]!;
        const s = card.s + (HELD_SCALE - card.s) * st.lift;
        const hw = 10 * s;
        const hh = 13.5 * s;
        let covered = 0;
        let n = 0;
        for (let dx = -hw; dx <= hw; dx += hw / 6) {
          for (let dy = -hh; dy <= hh; dy += hh / 6) {
            n++;
            if (inBody(st.hold[0] + dx, st.hold[1] + dy)) covered++;
          }
        }
        worst = Math.max(worst, covered / n);
      }
    }
    expect(worst, `${(worst * 100).toFixed(0)}% of the examined card is behind him`).toBeLessThan(0.15);
  });

  it("carries one card group per card, plus one spare per hand", () => {
    const html = mascotWelcomeMarkup("x");
    const stream = html.slice(html.indexOf('class="mw-cards"'), html.indexOf('class="mw-arms"'));
    expect([...stream.matchAll(/class="mw-card-g"/g)]).toHaveLength(CARDS.length);
    // Two spare nodes, so a held card is never the same node as its twin in the
    // stream: one is parked at the examine spot while the other keeps flowing.
    const held = html.slice(html.indexOf('class="mw-held"'), html.indexOf('class="mw-body"'));
    expect([...held.matchAll(/class="mw-card-g"/g)]).toHaveLength(2);
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


describe("the hand is a circle", () => {
  // Replaced a five-digit glove on 2026-08-23 (founder decision, DECISIONS.md).
  // What a circle cannot do is show a fist closing, so two things carry the
  // grip instead — a small squash, and WHERE on the card it lands — and both
  // are easy to undo without noticing.
  it("stays a perfect circle at rest", () => {
    const [across, along] = handScale(0);
    expect(across).toBeCloseTo(along, 6);
  });

  // The one the founder reported on 2026-08-23: a hand that went oval every
  // time it touched a card read as a blob squashing against the screen. Grip
  // changes SIZE, and nothing else.
  it("stays a circle while it grips a card, and only gets smaller", () => {
    const [across, along] = handScale(1);
    expect(across, "gripping a card must not deform the hand").toBeCloseTo(along, 6);
    expect(across, "a closing hand is smaller, not the same").toBeLessThan(handScale(0)[0]);
  });

  // The curtain is the ONE beat that is about taking hold of an edge, so the
  // deformation is spent there and reads precisely because it happens once.
  it("goes oval only for the curtain", () => {
    const [across, along] = handScale(0, 1);
    expect(along, "the pinched hand must be shorter along the arm").toBeLessThan(across);
    // Past ~20% a circle stops reading as a hand and starts reading as a ball.
    expect(across / along).toBeLessThan(1.4);
    expect(across / along, "a deformation this small is invisible").toBeGreaterThan(1.15);
  });

  it("takes the card by its NEAR corner, not its centre", () => {
    const card = CARDS[3]!;
    const t = 800;
    const centre = cardX(card, t);
    const left = gripPoint(card, t, 0);
    const right = gripPoint(card, t, 1);
    // The hand renders wider than a card, so a centred hand just covers it.
    expect(left[0], "left hand must reach the left side").toBeLessThan(centre);
    expect(right[0], "right hand must reach the right side").toBeGreaterThan(centre);
    expect(left[1], "and hold it above the middle").toBeLessThan(card.y);
    // Symmetric, or one hand would hold cards differently from the other.
    expect(centre - left[0]).toBeCloseTo(right[0] - centre, 6);
  });

  it("never lets go of the card it is carrying", () => {
    // Whatever phase it is in, the hand and the card it holds are one object.
    // The offset MOVES as the card grows (see `handOffset`), so what is pinned
    // here is that it is a pure function of how far out of the stream the card
    // is: the same lift on the way up and on the way down puts the hand in the
    // same place. Anything else is the card sliding around inside the grip.
    const byLift = new Map<string, [number, number]>();
    let held = 0;
    for (let t = 0; t < CYC * 12; t += 7) {
      for (const hand of [0, 1] as const) {
        const s = handWork(t, hand, hand === 0 ? 0 : HAND_PHASE_R);
        if (!s.hold) continue;
        held++;
        const off: [number, number] = [s.hold[0] - s.pos[0], s.hold[1] - s.pos[1]];
        expect(dist(s.hold, s.pos), "hand floated off its card").toBeLessThan(34);
        const key = `${hand}:${s.lift.toFixed(3)}`;
        const seen = byLift.get(key);
        if (seen) {
          expect(off[0]).toBeCloseTo(seen[0], 5);
          expect(off[1]).toBeCloseTo(seen[1], 5);
        } else byLift.set(key, off);
      }
    }
    expect(held, "no card is ever held — the test proves nothing").toBeGreaterThan(100);
  });

  it("does not cover the card it is holding up", () => {
    // The defect this pins was found on a render, not in a test: the grip
    // offset was a constant tuned against a stream card, so once the card grew
    // to `HELD_SCALE` the same offset parked a white disc over its photo and
    // half its text — on the ONE card he is supposed to be reading. Fully
    // lifted, the hand belongs clear of the card's face — which edge it grips
    // is a separate call (`handOffset` picks the bottom so the arm stays
    // visible), so this asserts the clearance and not the sign.
    const halfHeight = 13.5 * HELD_SCALE;
    let checked = 0;
    for (let t = 0; t < CYC * 12; t += 5) {
      for (const hand of [0, 1] as const) {
        const s = handWork(t, hand, hand === 0 ? 0 : HAND_PHASE_R);
        if (!s.hold || s.lift < 0.9) continue;
        checked++;
        expect(Math.abs(s.hold[1] - s.pos[1])).toBeGreaterThan(halfHeight);
      }
    }
    expect(checked, "nothing was ever fully lifted").toBeGreaterThan(100);
  });
});

describe("the turn", () => {
  it("never covers a fifth of the swing in one frame", () => {
    // The founder's first complaint, as a number (2026-08-23): "he spins round
    // very fast". Measured per 60Hz frame rather than end to end, the first
    // slowed version STILL moved 30% of the whole swing in a single frame at
    // the crossing — `EI` ends fast, `EO` starts at 3.09x its own average, and
    // the two halves met at full speed. Length was the smaller half of the fix;
    // this pins the shape.
    const swing = 1.06 - 0.05;
    let worst = 0;
    for (let t = 0; t <= BEATS.peer; t += 1000 / 60) {
      worst = Math.max(worst, Math.abs(gScaleX(t + 1000 / 60) - gScaleX(t)));
    }
    expect(worst / swing).toBeLessThan(0.2);
  });

  it("still crosses — the squash is not quietly tuned away", () => {
    // The cheap way to pass the test above is to stop turning. He has to go
    // nearly edge-on, and come back with a little overshoot.
    expect(gScaleX(BEATS.turn)).toBeLessThan(0.1);
    expect(gScaleX(BEATS.turn + 220)).toBeGreaterThan(1.02);
    expect(gScaleX(BEATS.peer)).toBeCloseTo(1, 2);
  });
});

describe("a grab is a whole gesture, not a tap", () => {
  // The complaint this answers (founder, 2026-08-23): "he does not take a card
  // and look at it, he just clicks at them". Everything below is a property of
  // picking something up that a fly-by touch does not have.

  it("runs its phases in order", () => {
    const order = [PHASE.reach, PHASE.close, PHASE.lift, PHASE.hold, PHASE.back, PHASE.open];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!, `phase ${i} must follow phase ${i - 1}`).toBeGreaterThan(order[i - 1]!);
    }
    expect(order[order.length - 1]!).toBeLessThan(1);
  });

  it("takes a card OUT of the stream and puts it back", () => {
    // Find a cycle where the left hand actually books something.
    const k = firstHit(0);
    const at = (f: number): ReturnType<typeof handWork> => handWork((k + f) * CYC, 0, 0);

    expect(at(0.05).hold, "still flying — nothing in hand").toBeNull();
    expect(at(PHASE.close - 0.01).hold, "on the card but not lifted yet").toBeNull();
    expect(at((PHASE.lift + PHASE.hold) / 2).hold, "must be out of the stream").not.toBeNull();
    expect(at(PHASE.open + 0.02).hold, "let go — back in the stream").toBeNull();
  });

  it("holds it still while the rest keep flowing", () => {
    const k = firstHit(0);
    const mid = handWork((k + (PHASE.lift + PHASE.hold) / 2) * CYC, 0, 0);
    const later = handWork((k + PHASE.hold - 0.005) * CYC, 0, 0);
    expect(mid.card).toBe(later.card);
    const card = CARDS[mid.card]!;
    // The card he is holding barely moves...
    expect(Math.abs(later.hold![0] - mid.hold![0])).toBeLessThan(1);
    // ...while its own stream position has moved on without it. That gap IS
    // the read: he pulled this one out and the others carried on.
    const drift = Math.abs(
      cardX(card, (k + PHASE.hold - 0.005) * CYC) -
        cardX(card, (k + (PHASE.lift + PHASE.hold) / 2) * CYC),
    );
    expect(drift, "the stream barely moves during the hold").toBeGreaterThan(3);
  });

  it("puts it back where the stream has got to, not where it was taken from", () => {
    const k = firstHit(0);
    const card = CARDS[handWork((k + PHASE.close) * CYC, 0, 0).card]!;
    const tookAt = cardX(card, (k + PHASE.close) * CYC);
    const back = handWork((k + PHASE.open - 0.005) * CYC, 0, 0);
    expect(back.pos[0]).toBeCloseTo(gripPoint(card, (k + PHASE.open - 0.005) * CYC, 0)[0], 6);
    expect(Math.abs(gripPoint(card, (k + PHASE.open - 0.005) * CYC, 0)[0] - tookAt)).toBeGreaterThan(
      8,
    );
  });

  it("uses both hands at once for a real stretch of every cycle", () => {
    // "sometimes with two hands, one card in each" — a phase offset that never
    // overlaps, or overlaps for two frames, does not deliver that.
    let both = 0;
    let steps = 0;
    for (let t = 0; t < CYC * 24; t += 6) {
      steps++;
      const a = handWork(t, 0, 0);
      const b = handWork(t, 1, HAND_PHASE_R);
      if (a.hold && b.hold) both++;
    }
    const share = both / steps;
    expect(share, "the two hands never hold a card at the same time").toBeGreaterThan(0.1);
    expect(share, "they are ALWAYS both holding — no solo beats left").toBeLessThan(0.32);
  });

  it("keeps at least one hand busy most of the time", () => {
    // The other half of the complaint: a hand that finds nothing in reach just
    // hovers, and at 1400ms per cycle a barren one is a second and a half of
    // nothing. Four of the nine cards used to be permanently unreachable.
    let busy = 0;
    let steps = 0;
    for (let t = 0; t < CYC * 40; t += 6) {
      steps++;
      if (handWork(t, 0, 0).hold || handWork(t, 1, HAND_PHASE_R).hold) busy++;
    }
    expect(busy / steps).toBeGreaterThan(0.6);
  });

  it("never covers a quarter of a flight in one frame", () => {
    // "The whole thing moves too fast" is, at the frame level, this: a
    // cubic-bezier leaves at `y1 / x1` times its own average speed, and the
    // ease this used to fly on starts at 3.09×. The hand crossed 23% of a
    // 96-unit reach in the first 60Hz frame and then crawled — a snap followed
    // by a glide. Rest-to-rest halves the worst frame. Same measurement, same
    // reasoning and the same fix as `--kb-ease` in the stylesheet.
    const k = firstHit(0);
    const t0 = k * CYC;
    const span = PHASE.reach * CYC;
    const at = (ms: number): [number, number] => handWork(t0 + ms, 0, 0).pos;
    const total = dist(at(0), at(span));
    let worst = 0;
    for (let ms = 0; ms + 16.7 <= span; ms += 16.7) {
      worst = Math.max(worst, dist(at(ms), at(ms + 16.7)) / total);
    }
    expect(total, "the flight is too short to measure anything").toBeGreaterThan(30);
    expect(worst, `worst frame covers ${(worst * 100).toFixed(1)}% of the flight`).toBeLessThan(
      0.15,
    );
  });

  it("only takes a card it can still put back on screen", () => {
    // The stream keeps flowing while he examines, so the card goes back to
    // wherever it has got to — which measured x = 165 on a stage that ends at
    // 150 before `targetFor` started checking the return. On screen that is an
    // arm shooting off the right edge to replace a card nobody can see, and
    // nothing else in the suite can see it: every other property still holds.
    // 120 cycles rather than a dozen because the hands and the stream run on
    // DIFFERENT clocks: a long walk is what explores their drifting phase
    // relationship, and shortening it would quietly stop testing the thing
    // that broke. What it must not do is spend an `expect()` per sample —
    // 18,667 steps x 2 hands x 6 assertions is ~224k matcher allocations for
    // one property, which is what made this file the suite's slowest by an
    // order of magnitude and its only test to time out under parallel load.
    // Collect and assert once: identical coverage, and the failure names the
    // first offending frame instead of the last.
    const offStage: string[] = [];
    for (let t = 0; t < CYC * 120; t += 9) {
      for (const [hand, off] of [
        [0, 0],
        [1, HAND_PHASE_R],
      ] as const) {
        const s = handWork(t, hand, off);
        if (s.pos[0] <= -45 || s.pos[0] >= 148) {
          offStage.push(`hand ${hand} x=${s.pos[0].toFixed(1)} at ${t}ms`);
        }
        if (s.pos[1] <= -24 || s.pos[1] >= 124) {
          offStage.push(`hand ${hand} y=${s.pos[1].toFixed(1)} at ${t}ms`);
        }
        if (s.hold && (s.hold[0] <= -42 || s.hold[0] >= 142)) {
          offStage.push(`card x=${s.hold[0].toFixed(1)} at ${t}ms`);
        }
      }
    }
    expect(offStage.slice(0, 5)).toEqual([]);
  });

  it("can reach most of the deck", () => {
    // The floor that decides this is a single number in `targetFor`, and
    // raising it silently starves the gesture rather than breaking anything.
    const reachable = new Set<number>();
    for (let k = 0; k < 200; k++) {
      for (const hand of [0, 1] as const) {
        const target = targetFor(hand, (k + PHASE.reach) * CYC);
        if (!target.miss) reachable.add(target.card);
      }
    }
    expect(reachable.size).toBeGreaterThanOrEqual(7);
  });

  it("never holds the same card in both hands at the same instant", () => {
    // The booking exclusion has to cover the whole hold, not the instant a
    // hand books — a gesture keeps its card for most of a cycle now.
    for (let t = 0; t < CYC * 24; t += 5) {
      const a = handWork(t, 0, 0);
      const b = handWork(t, 1, HAND_PHASE_R);
      if (a.card < 0 || b.card < 0) continue;
      expect(a.card, `both hands on card ${a.card} at ${t}ms`).not.toBe(b.card);
    }
  });

  it("examines cards at different heights", () => {
    // Four identical gestures in a row read as a machine. The examine height
    // is derived from the card's own, so it varies with what he picked up.
    const ys = new Set(CARDS.map((c) => Math.round(examineAt(c, 0)[1])));
    expect(ys.size).toBeGreaterThan(4);
    for (const c of CARDS) {
      const [x, y] = examineAt(c, 0);
      expect(x, "off the left edge of the stage").toBeGreaterThan(-30);
      expect(y, "above the stage").toBeGreaterThan(10);
      expect(y, "below the stage").toBeLessThan(120);
    }
  });
});

function dist(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** The first cycle in which `hand` actually books a card rather than missing. */
function firstHit(hand: 0 | 1): number {
  for (let k = 0; k < 40; k++) {
    if (!targetFor(hand, (k + PHASE.reach) * CYC).miss) return k;
  }
  throw new Error("the hand never books a card at all");
}

describe("the mascot's own stylesheet", () => {
  it("has no rule left for the deleted fingers", () => {
    expect(CSS.includes(".mw-digit"), "dead rule for a shape nothing draws").toBe(false);
    expect(CSS.indexOf(".mw-hand"), "the circle has no fill").toBeGreaterThan(-1);
  });

  it("draws the arm in something other than the dark page colour", () => {
    // With a big glove the limb could hide; a circle leaves the arm carrying
    // the whole shape of the reach, and #3b0b1e sits ~2% off the dark ground.
    const rule = CSS.slice(CSS.indexOf(".mw-arm {"), CSS.indexOf(".mw-arm {") + 90);
    expect(rule).toContain("fill:");
    expect(rule.toLowerCase(), "arm is invisible on the dark theme").not.toContain("#3b0b1e");
  });
});
