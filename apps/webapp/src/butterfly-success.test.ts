import { describe, expect, it, vi } from "vitest";
// Vite's `?raw` rather than `node:fs`: this package compiles with `types: []`
// (browser-only), so a Node builtin import would break `pnpm typecheck` even
// though vitest would happily run it. Same reasoning as butterfly-loader.test.ts.
// The CSS only arrives non-empty because vite.config.ts lists this stylesheet in
// `test.css.include` — vitest stubs CSS imports by default.
import CSS from "./butterfly-success.css?raw";
import {
  butterflySuccessMarkup,
  onSuccessSettle,
  restDelayFrom,
  settleDelayFrom,
  SPIN_PEAK_SCALE,
  TICK_PATH,
  TICK_STROKE,
  VIEWBOX,
  SUCCESS_ARRIVE_MS,
  SUCCESS_SETTLE_MS,
  SUCCESS_TOTAL_MS,
} from "./butterfly-success";
import { WING_BBOX, logoWingGradient } from "./brand-butterfly";

/**
 * `<duration>` and `<delay>` out of a shorthand `animation:` value.
 *
 * The tail is matched with `[\s\S]*?` rather than `[^,;]*?` because an easing
 * can be a `cubic-bezier(a, b, c, d)`, whose commas a comma-excluding class
 * cannot cross — which is how this helper first failed to see the arrival at
 * all. Lazy up to the fill mode, so it stops inside its own entry.
 */
function animation(name: string): { duration: number; delay: number } {
  const match = new RegExp(`${name}\\s+(\\d+)ms([\\s\\S]*?)(?:both|infinite)`).exec(CSS);
  if (!match) throw new Error(`no animation shorthand for ${name} in the stylesheet`);
  const delay = [...(match[2] ?? "").matchAll(/(\d+)ms/g)].at(-1)?.[1];
  return { duration: Number(match[1]), delay: Number(delay ?? 0) };
}

/** One stop of `@keyframes bfs-spin`, as authored. */
interface SpinStop {
  at: number;
  rotate: number;
  scale: number;
}

/**
 * Reads the spin's keyframes back out of the stylesheet.
 *
 * Brace-scanned rather than regex-sliced: a `@keyframes` body contains nested
 * blocks, so `[^}]*` stops at the first stop rather than the last.
 */
function spinStops(): SpinStop[] {
  const head = CSS.indexOf("@keyframes bfs-spin");
  expect(head, "the spin keyframes are gone from the stylesheet").toBeGreaterThan(-1);
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = head; i < CSS.length; i += 1) {
    if (CSS[i] === "{") {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = CSS.slice(start, end);
  const stops = [...body.matchAll(/(\d+)%\s*{([^}]*)}/g)].map((m) => {
    const transform = /rotate\((-?[\d.]+)deg\)\s*scale\(([\d.]+)\)/.exec(m[2] ?? "");
    if (!transform) throw new Error(`stop ${m[1]}% has no rotate+scale transform`);
    return {
      at: Number(m[1]),
      rotate: Number(transform[1]),
      scale: Number(transform[2]),
    };
  });
  expect(stops.length).toBeGreaterThan(6);
  return stops;
}

/**
 * Half-extents of the butterfly's axis-aligned box after rotating by `deg` and
 * scaling by `scale`.
 *
 * This is the number the frame has to clear, and it is NOT the scaled bbox: a
 * rectangle turned 45° reaches `(w + h) / 2√2` from its centre, which for the
 * wings is 53.8 against the 44.3 they occupy upright.
 */
function rotatedHalfExtents(deg: number, scale: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  const halfW = WING_BBOX.width / 2;
  const halfH = WING_BBOX.height / 2;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    x: scale * (halfW * cos + halfH * sin),
    y: scale * (halfW * sin + halfH * cos),
  };
}

describe("butterflySuccessMarkup", () => {
  it("labels the live region and escapes the caption", () => {
    const html = butterflySuccessMarkup({ label: `Done & <b>paid</b> "now"` });
    expect(html).toContain('role="status"');
    expect(html).toContain("Done &amp; &lt;b&gt;paid&lt;/b&gt; &quot;now&quot;");
    expect(html).not.toContain("<b>paid</b>");
  });

  it("omits the caption entirely when no label is given", () => {
    expect(butterflySuccessMarkup()).not.toContain("bfs-label");
  });

  it("still announces the success on a mark with no visible caption", () => {
    // Four of the five screens carry their own heading, so the captionless form
    // is the common one — and the drawing is aria-hidden, so this is the only
    // thing carrying the outcome to a screen reader.
    expect(butterflySuccessMarkup({ ariaLabel: "Verified" })).toContain('aria-label="Verified"');
  });

  it("hides the drawing from assistive tech and centres the frame on the origin", () => {
    const html = butterflySuccessMarkup({ label: "x" });
    expect(html).toContain(
      `viewBox="${-VIEWBOX.width / 2} ${-VIEWBOX.height / 2} ${VIEWBOX.width} ${VIEWBOX.height}"`,
    );
    expect(html).toContain('aria-hidden="true"');
  });

  it("draws ONE butterfly and ONE tick, in one frame, with no waist", () => {
    // One butterfly, not the loader's three, and no belly: the loader is
    // butterflies inside a waist (nerves), this one is the single butterfly
    // leaving. Both live in the same <svg> so the point it vanishes into and the
    // point the stroke grows from share a coordinate space by construction.
    const html = butterflySuccessMarkup();
    expect(html.match(/class="bfs-fly"/g)).toHaveLength(1);
    expect(html.match(/class="bfs-tick"/g)).toHaveLength(1);
    expect(html.match(/<svg /g)).toHaveLength(1);
    expect(html).not.toContain("belly");
  });

  it("declares pathLength on the tick, so the dash animation is 100 → 0", () => {
    // What lets the coordinates in TICK_PATH be retuned without the CSS silently
    // drawing a fraction of the stroke.
    expect(butterflySuccessMarkup()).toContain('pathLength="100"');
    expect(CSS).toContain("stroke-dasharray: 100");
  });

  it("leaves the tick's colour to CSS and everything else to attributes", () => {
    const html = butterflySuccessMarkup();
    // The wings cannot render unpainted if the stylesheet lands a frame late…
    expect(html).toContain('fill="url(#gnt-bfs-wing)"');
    expect(CSS).not.toMatch(/fill:\s*url\(/);
    // …and the tick deliberately does NOT get the same treatment: without CSS
    // there is no dash geometry either, so a hardcoded stroke would flash a
    // complete tick and rewind it. Unstroked-until-styled is the right failure.
    expect(html).not.toMatch(/class="bfs-tick"[^>]*\sstroke="/);
    expect(CSS).toContain("stroke: var(--bfs-tick)");
  });

  it("uses the shared logo gradient rather than a copy of it", () => {
    // The whole point of brand-butterfly.ts. A hand-copied gradient is how this
    // mark drifts from the logo one edit at a time — which is exactly what the
    // radius did before it was corrected to the normalised diagonal.
    expect(butterflySuccessMarkup()).toContain(logoWingGradient("gnt-bfs-wing"));
  });
});

describe("the gesture", () => {
  it("winds back the OTHER way before it spins, and eases as it does", () => {
    // The founder's spec, and the part that makes the spin read as a decision
    // rather than as the mark falling over: a small swing right, then away to
    // the left. A single eased rotation cannot express it, which is why the
    // animation is linear and the shape lives in the keyframes.
    //
    // Asserted as "everything before the turn goes right, and only right" rather
    // than "the maximum angle is positive" — the weaker form passes on a mark
    // that never winds up at all, because the spin's own first stop is still
    // slightly positive on its way through zero. That hole was found by
    // negating the wind-up and watching this test stay green.
    const stops = spinStops();
    const turn = stops.reduce((a, b) => (b.rotate > a.rotate ? b : a));
    const windUp = stops.slice(0, stops.indexOf(turn) + 1);
    expect(turn.rotate).toBeGreaterThan(0);
    for (let i = 1; i < windUp.length; i += 1) {
      expect(windUp[i]!.rotate, "the wind-up turns left somewhere").toBeGreaterThanOrEqual(
        windUp[i - 1]!.rotate,
      );
    }
    // …then away to the left, past a full three turns.
    expect(stops.at(-1)!.rotate).toBeLessThan(-360);

    // The swing itself eases OUT — it is a spring being drawn back, so it slows
    // as it reaches the end of its travel. The animation is `linear`, so this
    // too is keyframe spacing and nothing else would notice it going flat.
    const swing = windUp.slice(windUp.map((s) => s.rotate).lastIndexOf(0));
    const rates = swing
      .slice(1)
      .map((s, i) => (s.rotate - swing[i]!.rotate) / (s.at - swing[i]!.at));
    expect(rates.length).toBeGreaterThan(1);
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i], "the wind-up runs at a constant rate").toBeLessThan(rates[i - 1]!);
    }
  });

  it("accelerates: every slice of the spin covers more rotation than the last", () => {
    // The one property the whole effect rests on. It is expressed as keyframe
    // SPACING under a `linear` timing function, so nothing but this test notices
    // if a stop is retuned into a constant-speed turn.
    const stops = spinStops();
    const peakAt = stops.reduce((a, b) => (b.rotate > a.rotate ? b : a)).at;
    const spin = stops.filter((s) => s.at >= peakAt);
    const rates = spin.slice(1).map((s, i) => {
      const prev = spin[i]!;
      return Math.abs(s.rotate - prev.rotate) / (s.at - prev.at);
    });
    expect(rates.length).toBeGreaterThan(4);
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i], `slice ${i} of the spin is not faster than the one before`).toBeGreaterThan(
        rates[i - 1]!,
      );
    }
  });

  it("shrinks monotonically once the spin is under way, down to a point", () => {
    const stops = spinStops();
    const peak = stops.reduce((a, b) => (b.scale > a.scale ? b : a));
    expect(peak.scale).toBeCloseTo(SPIN_PEAK_SCALE, 3);
    const after = stops.filter((s) => s.at >= peak.at);
    for (let i = 1; i < after.length; i += 1) {
      expect(after[i]!.scale).toBeLessThan(after[i - 1]!.scale);
    }
    expect(after.at(-1)!.scale).toBeLessThan(0.1);
  });

  it("leaves nothing of the butterfly in the resting frame", () => {
    expect(spinStops().at(-1)!).toMatchObject({ at: 100 });
    const body = CSS.slice(CSS.indexOf("@keyframes bfs-spin"));
    expect(/100%\s*{\s*opacity:\s*0;/.test(body)).toBe(true);
  });
});

describe("geometry", () => {
  it("contains the butterfly through the whole spin, so the frame cannot shear a wing", () => {
    // An SVG crops silently and a clipped wing is a hard straight cut that reads
    // as a rendering fault. Sampling the INTERPOLATION and not just the stops is
    // the point: the widest frame of this animation (~45°, scale ~1.02) falls
    // between two authored keyframes, so a stop-only check would miss it.
    const stops = spinStops();
    let worst = 0;
    for (let i = 1; i < stops.length; i += 1) {
      const a = stops[i - 1]!;
      const b = stops[i]!;
      for (let step = 0; step <= 40; step += 1) {
        const t = step / 40;
        const half = rotatedHalfExtents(
          a.rotate + (b.rotate - a.rotate) * t,
          a.scale + (b.scale - a.scale) * t,
        );
        worst = Math.max(worst, half.x, half.y);
      }
    }
    expect(worst).toBeLessThan(VIEWBOX.width / 2);
    expect(worst).toBeLessThan(VIEWBOX.height / 2);
    // And it genuinely needs the room: an unrotated butterfly would fit in far
    // less, so a future "tidy-up" back to a tight frame is a real hazard.
    expect(worst).toBeGreaterThan(WING_BBOX.width / 2);
  });

  it("contains the tick, round caps included", () => {
    const points = [...TICK_PATH.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    expect(points).toHaveLength(3);
    const cap = TICK_STROKE / 2;
    for (const p of points) {
      expect(Math.abs(p.x) + cap).toBeLessThan(VIEWBOX.width / 2);
      expect(Math.abs(p.y) + cap).toBeLessThan(VIEWBOX.height / 2);
    }
  });

  it("reads as a tick rather than a chevron", () => {
    // Arms at roughly 1:2. Even arms are a chevron, and the difference is the
    // whole reason this shape is written out by hand rather than generated.
    const [a, b, c] = [...TICK_PATH.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    const len = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(q.x - p.x, q.y - p.y);
    expect(len(b!, c!) / len(a!, b!)).toBeGreaterThan(1.5);
    // The elbow is the lowest point, and the tail rises above the start.
    expect(b!.y).toBeGreaterThan(a!.y);
    expect(c!.y).toBeLessThan(a!.y);
  });

  it("keeps the frame square, so the mark cannot be squashed or crop mid-turn", () => {
    // A rotating mark needs equal clearance in both axes; the pre-spin frame was
    // 104 x 76 and would have sheared a wing on the first quarter-turn.
    expect(VIEWBOX.width).toBe(VIEWBOX.height);
    const mark = /\.bfs-mark\s*{([^}]*)}/.exec(CSS)?.[1] ?? "";
    expect(mark).toContain("width: var(--bfs-w)");
    expect(mark).toContain("height: var(--bfs-w)");
  });
});

describe("timing", () => {
  it("fires the haptic when the TICK finishes, not when the butterfly leaves", () => {
    const draw = animation("bfs-draw");
    expect(draw.delay + draw.duration).toBe(SUCCESS_ARRIVE_MS);
  });

  it("starts the tick before the butterfly is gone, so one becomes the other", () => {
    // Queued back to back this reads as two animations; overlapped it reads as a
    // morph. The overlap is small on purpose — the butterfly is a ~0.2 blur by
    // then, so it sits on the tick's first pixels rather than obscuring them.
    const spin = animation("bfs-spin");
    const draw = animation("bfs-draw");
    expect(draw.delay).toBeLessThan(spin.delay + spin.duration);
    expect(spin.delay + spin.duration).toBeLessThan(draw.delay + draw.duration);
  });

  it("brings the bloom and the caption to rest on the same frame", () => {
    // One moment of coming to rest rather than three. The failure mode is a
    // self-dismissing screen closing over a glow that is still rising.
    const bloom = animation("bfs-bloom");
    const label = animation("bfs-label-in");
    expect(bloom.delay + bloom.duration).toBe(SUCCESS_TOTAL_MS);
    expect(label.delay + label.duration).toBe(SUCCESS_TOTAL_MS);
    expect(SUCCESS_ARRIVE_MS + SUCCESS_SETTLE_MS).toBe(SUCCESS_TOTAL_MS);
  });

  it("holds the bloom and the caption back until the answer is arriving", () => {
    // Both used to rise with the mark's entrance. Here the entrance is a
    // butterfly that is about to leave, and a caption reading "verified" over it
    // gives the ending away before the gesture has made it.
    const draw = animation("bfs-draw");
    expect(animation("bfs-bloom").delay).toBeGreaterThan(draw.delay / 2);
    expect(animation("bfs-label-in").delay).toBeGreaterThan(draw.delay / 2);
  });

  it("stays inside the budget the self-dismissing screens were built around", () => {
    // Verification and Type Radar both close on SUCCESS_TOTAL_MS + SUCCESS_READ_MS.
    // This is real added time in the onboarding funnel, so it is pinned rather
    // than left to drift one retune at a time.
    expect(SUCCESS_TOTAL_MS).toBeLessThanOrEqual(1400);
  });

  it("clamps a mark whose success arrived late", () => {
    // Verification renders the mark and THEN waits on the network, so by the
    // time it wants to buzz the draw is often already over.
    expect(settleDelayFrom(1000, 1200)).toBe(SUCCESS_ARRIVE_MS - 200);
    expect(settleDelayFrom(1000, 9000)).toBe(0);
    expect(restDelayFrom(1000, 9000)).toBe(0);
  });
});

describe("reduced motion", () => {
  it("rests on the FINAL pose, so no keyframe has to be restated", () => {
    // The base values are the finished ones, which is what makes killing the
    // animations sufficient. Restating them was the old bug: a second copy of
    // the landed pose that had to be kept in step by hand.
    const fly = /\.bfs-fly\s*{([^}]*)}/.exec(CSS)?.[1] ?? "";
    const tick = /\.bfs-tick\s*{([^}]*)}/.exec(CSS)?.[1] ?? "";
    const bloom = /\.bfs-mark::before\s*{([^}]*)}/.exec(CSS)?.[1] ?? "";
    // The butterfly is not part of the resting frame at all.
    expect(fly).toContain("opacity: 0");
    expect(tick).toContain("stroke-dashoffset: 0");
    expect(tick).toContain("opacity: 1");
    expect(bloom).toContain("opacity: 0.8");
  });

  it("kills every animation but still lets the success arrive", () => {
    const block = CSS.slice(CSS.indexOf("prefers-reduced-motion"));
    for (const sel of [".bfs-fly", ".bfs-tick", ".bfs-mark::before", ".bfs-label"]) {
      expect(block, `${sel} keeps animating under reduced motion`).toContain(sel);
    }
    expect(block).toContain("animation: none");
    // Not "appears as though the screen never changed".
    expect(block).toContain("bfs-fade-in");
    // And nothing is restated: the media query says only `animation: none`.
    expect(block).not.toMatch(/opacity:\s*0\.8/);
  });
});

describe("theme", () => {
  it("lifts the tick's burgundy on the dark page", () => {
    // #8b253b sinks into the near-black background — the same correction the
    // date card makes to its accent on dark, for the same reason.
    const dark = /\.bfs\s*{([^}]*)}/.exec(CSS)?.[1] ?? "";
    const light = /\[data-theme="light"\]\s*\.bfs\s*{([^}]*)}/.exec(CSS)?.[1] ?? "";
    expect(dark).toContain("--bfs-tick: var(--accent-bright");
    expect(light).toContain("--bfs-tick: var(--accent,");
  });
});

describe("onSuccessSettle", () => {
  it("pulses when the tick lands", () => {
    vi.useFakeTimers();
    try {
      const pulse = vi.fn();
      onSuccessSettle(pulse);
      vi.advanceTimersByTime(SUCCESS_ARRIVE_MS - 1);
      expect(pulse).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(pulse).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot buzz about a success that has left the screen", () => {
    vi.useFakeTimers();
    try {
      const pulse = vi.fn();
      onSuccessSettle(pulse)();
      vi.advanceTimersByTime(SUCCESS_ARRIVE_MS * 4);
      expect(pulse).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
