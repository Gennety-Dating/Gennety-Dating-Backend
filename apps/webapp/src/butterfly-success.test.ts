import { describe, expect, it, vi } from "vitest";
// Vite's `?raw` rather than `node:fs`: this package compiles with `types: []`
// (browser-only), so a Node builtin import would break `pnpm typecheck` even
// though vitest would happily run it. Same reasoning as butterfly-loader.test.ts.
// The CSS only arrives non-empty because vite.config.ts lists this stylesheet in
// `test.css.include` — vitest stubs CSS imports by default.
import CSS from "./butterfly-success.css?raw";
import LOADER_CSS from "./butterfly-loader.css?raw";
import {
  butterflySuccessMarkup,
  onSuccessSettle,
  CHECK_END,
  CHECK_START,
  BUTTERFLY_LEAD,
  CHECK_VERTEX,
  DRAW_END_PCT,
  EXIT_STOPS,
  FLIGHT_STOPS,
  PEAK_SCALE,
  VIEWBOX,
  SUCCESS_EXIT_MS,
  SUCCESS_FLIGHT_MS,
  SUCCESS_SETTLE_MS,
  SUCCESS_TOTAL_MS,
} from "./butterfly-success";
import { WING_BBOX } from "./brand-butterfly";

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
    // All four screens this replaced carry their own heading, so the captionless
    // form is the common one — and on those screens the mark IS the confirmation.
    expect(butterflySuccessMarkup({ ariaLabel: "Verified" })).toContain('aria-label="Verified"');
  });

  it("hides the drawing from assistive tech — the wrapper is the announced part", () => {
    expect(butterflySuccessMarkup({ label: "x" })).toContain(
      `<svg class="bfs-svg" viewBox="0 0 ${VIEWBOX.width} ${VIEWBOX.height}" aria-hidden="true"`,
    );
  });

  it("draws one butterfly with two independently flapping wings", () => {
    // One, not the loader's three: the loader is butterflies inside a waist
    // (nerves), this one is the single butterfly out and landed.
    const html = butterflySuccessMarkup();
    expect(html.match(/class="bfs-fly"/g)).toHaveLength(1);
    expect(html.match(/class="bfs-wing"/g)).toHaveLength(2);
    expect(html).not.toContain("belly");
  });

  it("traces the tick through the exported three points", () => {
    // The `d`, the trail gradient's axis and the flight keyframes all have to
    // agree on where the tick is; these constants are the one source they share.
    expect(butterflySuccessMarkup()).toContain(
      `d="M ${CHECK_START.x} ${CHECK_START.y} L ${CHECK_VERTEX.x} ${CHECK_VERTEX.y} L ${CHECK_END.x} ${CHECK_END.y}"`,
    );
  });

  it("normalises the dash arithmetic with pathLength", () => {
    // Without it every dashoffset stop in the stylesheet would be a hand-computed
    // multiple of the real path length (~118.8 units), and nudging the tick's
    // geometry would silently desynchronise the draw from the flight.
    expect(butterflySuccessMarkup()).toContain('pathLength="100"');
    expect(CSS).toContain("stroke-dasharray: 100");
  });

  it("runs the trail gradient along the tick, bright at the start and deep at the tip", () => {
    const html = butterflySuccessMarkup();
    // Along the tick's own axis: across-the-frame endpoints would put the bright
    // end wherever the frame happened to be widest, which is not where the
    // motion is.
    expect(html).toContain(
      `x1="${CHECK_START.x}" y1="${CHECK_START.y}" x2="${CHECK_END.x}" y2="${CHECK_END.y}"`,
    );
    // Light ink -> heavy ink, agreeing with the stroke-width ramp. It ends on the
    // brand accent exactly, and the range is narrow on purpose: at #C82356 the
    // finished mark read as a PINK tick, and the bright stroke also swallowed the
    // butterfly, which is darker than that in its upper lobes.
    expect(html).toContain('<stop offset="0%" stop-color="#9C2B44"/>');
    expect(html).toContain('<stop offset="100%" stop-color="#8B253B"/>');
  });

  it("keeps the butterfly the brightest thing, not the stroke", () => {
    // The one contrast rule of this mark. The logo carries a bright magenta lobe;
    // the trail it leaves is ink. Invert them and the butterfly reads as a dark
    // smudge ON the line rather than an object above it — which is exactly what it
    // looked like before the range was narrowed.
    const html = butterflySuccessMarkup();
    const trail = html.slice(html.indexOf('id="gnt-bfs-trail"'), html.indexOf("</linearGradient>"));
    const luminance = (hex: string): number => {
      const n = Number.parseInt(hex.slice(1), 16);
      // Rough perceptual weighting; only the ordering matters here.
      return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    };
    const trailStops = [...trail.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]!);
    const wingStops = [
      ...html.slice(0, html.indexOf('id="gnt-bfs-trail"')).matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g),
    ].map((m) => m[1]!);
    expect(trailStops).toHaveLength(2);
    expect(wingStops.length).toBeGreaterThan(1);
    expect(Math.max(...wingStops.map(luminance))).toBeGreaterThan(
      Math.max(...trailStops.map(luminance)),
    );
  });

  it("paints from attributes, so a late stylesheet cannot render it unpainted", () => {
    const html = butterflySuccessMarkup();
    expect(html).toContain('stroke="url(#gnt-bfs-trail)"');
    expect(html).toContain('fill="url(#gnt-bfs-wing)"');
    expect(CSS).not.toMatch(/stroke:\s*url\(/);
  });

  it("keeps the logo's single gradient across both split wings", () => {
    // Two separate wing paths, so an objectBoundingBox gradient would restart at
    // each one and turn the butterfly symmetric, losing the logo's off-centre glow.
    const html = butterflySuccessMarkup();
    expect(html).toContain('gradientUnits="userSpaceOnUse"');
    for (const stop of ["#FF00FF", "#C82356", "#8B253B", "#3B0B1E"]) {
      expect(html).toContain(`stop-color="${stop}"`);
    }
  });

  it("uses its own gradient ids so it can coexist with the loading mark", () => {
    // A React transition from loading to success can have both mounted for a
    // frame; identical document-wide ids would collide.
    const html = butterflySuccessMarkup();
    expect(html).toContain('id="gnt-bfs-wing"');
    expect(html).not.toContain('id="gnt-bfl-wing"');
  });
});

describe("flight geometry", () => {
  it("keeps every VISIBLE keyframe's banked butterfly inside the frame", () => {
    // An SVG crops silently, so this needs real arithmetic — and two naive
    // versions of it have already let a clipped wing through. Measuring the wings'
    // own 88.6 × 63.4 box ignores the bank, and a rotated box is far larger;
    // checking one constant against CHECK_END misses that the butterfly is offset
    // off the line by BUTTERFLY_LEAD and is widest a beat before the tip. So walk
    // what is actually authored: every keyframe, with its own scale and rotation.
    const frames = flightFrames(CSS);
    expect(frames).toHaveLength(FLIGHT_STOPS.length + EXIT_STOPS.length - 1);
    for (const f of frames) {
      // The last keyframe is at opacity 0 — invisible, so allowed to graze.
      if (f.opacity === 0) continue;
      const rad = (Math.abs(f.rotate) * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const halfW = ((WING_BBOX.width * c + WING_BBOX.height * s) * f.scale) / 2;
      const halfH = ((WING_BBOX.width * s + WING_BBOX.height * c) * f.scale) / 2;
      expect(f.x - halfW, `${f.stop}% left`).toBeGreaterThan(0);
      expect(f.x + halfW, `${f.stop}% right`).toBeLessThan(VIEWBOX.width);
      expect(f.y - halfH, `${f.stop}% top`).toBeGreaterThan(0);
      expect(f.y + halfH, `${f.stop}% bottom`).toBeLessThan(VIEWBOX.height);
    }
  });

  it("centres the resting tick in the frame", () => {
    // The tick is what rests here; the butterfly is transient. The frame used to
    // be sized around a LANDED butterfly's wing, which left the tick 8 units left
    // of centre — visible as a mark that sits slightly off on every screen.
    const halfStroke = 9.5 / 2;
    const left = CHECK_START.x - halfStroke;
    const right = VIEWBOX.width - (CHECK_END.x + halfStroke);
    const bottom = VIEWBOX.height - (CHECK_VERTEX.y + halfStroke);
    const top = CHECK_END.y - halfStroke;
    expect(Math.abs(left - right)).toBeLessThan(1);
    expect(Math.abs(top - bottom)).toBeLessThan(1);
  });

  it("flies the butterfly clear of the stroke it is drawing", () => {
    // Without the lead the butterfly sits ON the line, in the same hue, and reads
    // as a lump on it rather than the thing making it. At the tip the lead is
    // purely vertical (see BUTTERFLY_LEAD), so it is directly checkable.
    const tip = flightFrames(CSS).find((f) => f.stop === DRAW_END_PCT);
    expect(tip).toBeTruthy();
    expect(tip!.x).toBe(CHECK_END.x);
    expect(CHECK_END.y - tip!.y).toBe(BUTTERFLY_LEAD);
  });

  it("puts the vertex below both arm ends, i.e. draws a tick and not a caret", () => {
    expect(CHECK_VERTEX.y).toBeGreaterThan(CHECK_START.y);
    expect(CHECK_VERTEX.y).toBeGreaterThan(CHECK_END.y);
    // The long arm is the right one — a tick with two equal arms reads as a "v".
    expect(CHECK_END.x - CHECK_VERTEX.x).toBeGreaterThan(CHECK_VERTEX.x - CHECK_START.x);
  });
});

describe("stylesheet", () => {
  it("defines every animation the markup relies on", () => {
    for (const name of [
      "bfs-flight",
      "bfs-draw",
      "bfs-flap",
      "bfs-bloom",
      "bfs-label-in",
      "bfs-fade-in",
    ]) {
      expect(CSS).toContain(`@keyframes ${name}`);
    }
  });

  it("flies and draws on the SAME stops", () => {
    // THE invariant of this mark. The butterfly's position and the stroke's
    // dashoffset are two animations on two elements selling one illusion — the
    // butterfly laying the stroke down behind it. Different stops (or a
    // different easing) and the stroke tip separates from the butterfly
    // mid-sweep, which is the one failure a reviewer would call "cheap".
    // The two animations share ONE timeline, so the draw's stops are directly
    // comparable to the flight's: the draw reaches its last keyframe where the
    // stroke closes and holds, while the flight carries on through the exit.
    const flight = keyframeBlock(CSS, "bfs-flight");
    const draw = keyframeBlock(CSS, "bfs-draw");
    expect(stopsOf(draw)).toEqual([...FLIGHT_STOPS]);
    expect(stopsOf(flight)).toEqual([...FLIGHT_STOPS, ...EXIT_STOPS.slice(1)]);
    // The shared segment ends exactly where the constants say the drawing does.
    expect(FLIGHT_STOPS.at(-1)).toBe(DRAW_END_PCT);
    expect(EXIT_STOPS[0]).toBe(DRAW_END_PCT);
  });

  it("keeps both halves linear, so the acceleration lives in the stop spacing", () => {
    // An easing curve would have to be applied identically to a transform and to
    // a dashoffset to stay in step; spacing cannot drift the way two curves can.
    expect(CSS).toMatch(new RegExp(`animation: bfs-flight ${SUCCESS_TOTAL_MS}ms linear both`));
    expect(CSS).toMatch(new RegExp(`animation: bfs-draw ${SUCCESS_TOTAL_MS}ms linear both`));
  });

  it("actually accelerates into the dive and decelerates into the levelling-out", () => {
    // Not a restatement of the stop list: this is the claim the spacing makes.
    // Progress per unit time has to rise through the vertex and fall to the
    // landing, or the swoop reads as a constant-rate slide.
    const rates = pairwiseRates(keyframeBlock(CSS, "bfs-draw"));
    const peak = rates.indexOf(Math.max(...rates));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(rates.length - 1);
    expect(rates.at(-1)).toBeLessThan(rates[peak]!);
  });

  it("draws the stroke bolder as it is laid down", () => {
    const draw = keyframeBlock(CSS, "bfs-draw");
    expect(draw).toMatch(/stroke-width: 6/);
    expect(draw).toMatch(/stroke-width: 9\.5/);
  });

  it("LEAVES rather than landing — the resting frame is the tick alone", () => {
    // The correction this mark exists in its current form for. Holding the logo
    // still on the tick's point reads as a sticker stuck onto it, not as one
    // mark. The butterfly is the instrument: it draws and goes.
    const block = withoutComments(keyframeBlock(CSS, "bfs-flight"));
    expect(block).toMatch(/100% \{\s*opacity: 0;/);
    // And it never straightens up on the way out. Levelling to rotate(0) was only
    // ever needed to land upright; with nothing landing it would read as a swoop
    // that stops and squares itself off.
    expect(block).not.toContain("rotate(0deg)");
  });

  it("holds the tick's own bank through the up-sweep and out", () => {
    // The butterfly flies ALONG the line it is drawing. The second arm is at
    // exactly -45°, so anything far off that reads as sliding sideways.
    const block = withoutComments(keyframeBlock(CSS, "bfs-flight"));
    const rotations = [...block.matchAll(/rotate\((-?[\d.]+)deg\)/g)].map((m) => Number(m[1]));
    // Everything from the point the sweep is established onward, i.e. the last
    // five stops: 48%, 61.5%, 69%, 75% (draw ends), then the two exit stops.
    for (const deg of rotations.slice(-5)) {
      expect(deg).toBeLessThanOrEqual(-40);
      expect(deg).toBeGreaterThanOrEqual(-55);
    }
  });

  it("grows the butterfly monotonically through the draw, then recedes", () => {
    // Regression guard, and a real one: rescaling this curve by hand produced a
    // sequence where the vertex was momentarily LARGER than the frame after it,
    // i.e. the butterfly flew toward the viewer and then backed off in the middle
    // of the sweep. Perspective that reverses reads as a glitch, not as depth.
    const block = withoutComments(keyframeBlock(CSS, "bfs-flight"));
    const scales = [...block.matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(scales).toHaveLength(FLIGHT_STOPS.length + EXIT_STOPS.length - 1);
    const drawing = scales.slice(0, FLIGHT_STOPS.length);
    expect(drawing).toEqual([...drawing].sort((a, b) => a - b));
    expect(drawing.at(-1)).toBe(PEAK_SCALE);
    // The exit shrinks, strictly — that is what makes it read as flying away
    // rather than fading on the spot.
    const leaving = scales.slice(FLIGHT_STOPS.length - 1);
    expect(leaving).toEqual([...leaving].sort((a, b) => b - a));
    expect(new Set(leaving).size).toBe(leaving.length);
  });

  it("keeps one size knob, with the aspect derived from the viewBox", () => {
    // Setting a width and a height independently is how the tick gets squashed;
    // the ratio is the viewBox's, so it is not a free parameter.
    expect(CSS).toContain("--bfs-w:");
    const aspect = `height: calc(var(--bfs-w) * ${VIEWBOX.height} / ${VIEWBOX.width})`;
    expect(ruleBlock(CSS, ".bfs-svg")).toContain(aspect);
    expect(ruleBlock(CSS, ".bfs-mark")).toContain(aspect);
  });

  it("is borderless — no disc, ring or plate behind the tick", () => {
    // Three of the four marks this replaced sat inside a filled circle, which is
    // what made them read as a system dialog rather than as this product.
    const mark = CSS.slice(CSS.indexOf(".bfs-mark"), CSS.indexOf(".bfs-svg"));
    expect(mark).not.toMatch(/border:/);
    // The only round thing is the bloom, and it is a transparent radial glow.
    expect(mark).toContain("radial-gradient");
  });

  it("flaps exactly the loading mark's beat", () => {
    // Two marks of the same butterfly must not flap differently.
    expect(keyframeBlock(CSS, "bfs-flap").replace(/bfs/g, "bfl")).toEqual(
      keyframeBlock(LOADER_CSS, "bfl-flap"),
    );
  });

  it("flaps for the whole beat, not just the drawing part of it", () => {
    // 150ms × 8 covers the exit too, so it is still flapping as it goes rather
    // than gliding out stiffly. A count that stops at the draw would leave the
    // wings frozen open for the last quarter of the animation.
    const wing = ruleBlock(CSS, ".bfs-wing");
    const iterations = Number(/animation: bfs-flap 150ms linear (\d+)/.exec(wing)?.[1]);
    expect(iterations * 150).toBe(SUCCESS_TOTAL_MS);
  });

  it("stops all travel under prefers-reduced-motion but keeps the finished mark", () => {
    const block = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation: none");
    // Deliberately restates NO pose: the base states already are the resting
    // ones, so killing the animations is the whole rule. A second copy of the
    // final transform here is what used to have to be kept in step by hand.
    expect(block).not.toContain("transform:");
    expect(block).not.toContain("stroke-dashoffset");
    // The success still ARRIVES rather than being there as if nothing changed.
    expect(block).toContain("animation: bfs-fade-in");
  });

  it("bases the un-animated state on the FINAL pose — tick drawn, butterfly gone", () => {
    // This is what reduced motion falls back to, and what a frame between mount
    // and animation start shows. Basing it on the entry pose would flash a tiny
    // butterfly in the wrong corner with no stroke at all; basing it on a LANDED
    // pose would put a still logo on the tick, which is the reading this mark was
    // changed to remove.
    const fly = ruleBlock(CSS, ".bfs-fly");
    expect(fly).toContain("opacity: 0");
    expect(ruleBlock(CSS, ".bfs-trail")).toContain("stroke-dashoffset: 0");
    // The base pose must be the flight's own last keyframe, or reduced motion and
    // the animation's end disagree about where the butterfly finished.
    const last = withoutComments(keyframeBlock(CSS, "bfs-flight")).split("100% {").pop() ?? "";
    const transform = /transform: ([^;]+);/.exec(last)?.[1];
    expect(transform).toBeTruthy();
    expect(fly).toContain(`transform: ${transform};`);
    // And the wings' base is open, so a wing is never frozen mid-fold.
    expect(ruleBlock(CSS, ".bfs-wing")).toContain("transform: scaleX(1)");
  });

  it("gives the cream page its own bloom value", () => {
    // The dark-theme alpha reads as a pink smudge under the stroke on cream.
    expect(CSS).toContain('[data-theme="light"] .bfs');
  });

  it("resolves the caption colour even on a page that never declared the token", () => {
    // verification.html carries hand-inlined theme tokens and was missing
    // `--text-faint` when the loading mark shipped. A shared mark must not fail
    // over a token any one page can forget.
    expect(CSS).toContain("--bfs-caption: var(--text-muted, #8e8895)");
    expect(CSS).not.toMatch(/color:\s*var\(--text-muted\)\s*;/);
  });
});

describe("timing constants", () => {
  it("puts the drawing's end where the constants say it is", () => {
    // SUCCESS_FLIGHT_MS is what call sites use to time the haptic, so if the
    // stylesheet's draw-end stop drifts from it the buzz lands away from the
    // frame the tick actually closes on.
    expect(DRAW_END_PCT).toBe(75);
    expect(SUCCESS_FLIGHT_MS).toBe((DRAW_END_PCT / 100) * SUCCESS_TOTAL_MS);
    expect(keyframeBlock(CSS, "bfs-draw")).toContain(`${DRAW_END_PCT}% {`);
  });

  it("lets everything come to rest on the SAME frame", () => {
    // One moment of settling rather than three. The exit, the bloom (720 + 480)
    // and the caption (820 + 380) all finish at TOTAL — and TOTAL must not be
    // shorter than the last thing still moving, or a self-dismissing screen cuts
    // it off mid-fade.
    expect(SUCCESS_TOTAL_MS).toBe(SUCCESS_FLIGHT_MS + SUCCESS_SETTLE_MS);
    expect(SUCCESS_SETTLE_MS).toBe(SUCCESS_EXIT_MS);
    expect(720 + 480).toBe(SUCCESS_TOTAL_MS);
    expect(820 + 380).toBe(SUCCESS_TOTAL_MS);
    expect(CSS).toContain("animation: bfs-bloom 480ms ease-out 720ms both");
    expect(CSS).toContain("animation: bfs-label-in 380ms ease-out 820ms both");
  });
});

describe("onSuccessSettle", () => {
  it("fires the pulse at the landing, not on mount", () => {
    vi.useFakeTimers();
    try {
      const pulse = vi.fn();
      onSuccessSettle(pulse);
      expect(pulse).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SUCCESS_FLIGHT_MS - 1);
      expect(pulse).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(pulse).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be cancelled, so a screen that changes cannot buzz about a stale success", () => {
    vi.useFakeTimers();
    try {
      const pulse = vi.fn();
      onSuccessSettle(pulse)();
      vi.advanceTimersByTime(SUCCESS_FLIGHT_MS * 2);
      expect(pulse).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pulses immediately when the viewer asked for less motion", () => {
    // The mark is drawn already finished there, so a pulse 900ms later would
    // buzz about something that stopped moving before they looked at it.
    const original = globalThis.matchMedia;
    // Stubbing a DOM API the test runner has no implementation of at all.
    (globalThis as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: true });
    try {
      const pulse = vi.fn();
      const cancel = onSuccessSettle(pulse);
      expect(pulse).toHaveBeenCalledTimes(1);
      expect(() => cancel()).not.toThrow();
    } finally {
      if (original) globalThis.matchMedia = original;
      else delete (globalThis as Partial<typeof globalThis>).matchMedia;
    }
  });
});

/** Strips CSS block comments. The stylesheet's own prose contains percentages
 *  ("levels out over the last 8%"), which a stop scanner would otherwise read as
 *  a keyframe stop — so the comments have to go before any of this parses. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The body of one plain rule, matched on the selector alone.
 *
 * Slicing "from this selector to the next thing I happen to know follows it" is
 * how a reordered stylesheet turns a real assertion into a vacuous one — the
 * base-state test passed against `.bfs-fly` while silently missing `.bfs-trail`,
 * which sits ABOVE it, for exactly that reason.
 */
function ruleBlock(css: string, selector: string): string {
  const clean = withoutComments(css);
  const start = clean.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`rule ${selector} not found`);
  const end = clean.indexOf("}", start);
  if (end === -1) throw new Error(`rule ${selector} is unbalanced`);
  return clean.slice(start, end + 1);
}

/** The body of one `@keyframes` block, brace-matched. */
function keyframeBlock(css: string, name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start === -1) throw new Error(`@keyframes ${name} not found`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`@keyframes ${name} is unbalanced`);
}

/** Every stop percentage in a keyframe body, in source order. */
function stopsOf(block: string): number[] {
  return [...withoutComments(block).matchAll(/(?:^|[\s,{])(\d+(?:\.\d+)?)%/g)].map((m) =>
    Number(m[1]),
  );
}

/**
 * Every authored flight keyframe, parsed.
 *
 * The point of parsing rather than importing constants: the keyframes are where
 * the geometry actually lives, so a check that restates a constant cannot catch a
 * position that was hand-edited. `opacity` is only declared on some stops, so it
 * carries forward from the previous one, which is what CSS interpolation does.
 */
function flightFrames(css: string): {
  stop: number;
  x: number;
  y: number;
  rotate: number;
  scale: number;
  opacity: number;
}[] {
  const block = withoutComments(keyframeBlock(css, "bfs-flight"));
  const re =
    /(\d+(?:\.\d+)?)% \{([^}]*)\}/g;
  const out: ReturnType<typeof flightFrames> = [];
  let opacity = 1;
  for (const [, stop, body] of block.matchAll(re)) {
    const o = /opacity: ([\d.]+)/.exec(body!);
    if (o) opacity = Number(o[1]);
    const t =
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\) rotate\((-?[\d.]+)deg\) scale\(([\d.]+)\)/.exec(
        body!,
      );
    if (!t) throw new Error(`keyframe ${stop}% has no parsable transform`);
    out.push({
      stop: Number(stop),
      x: Number(t[1]),
      y: Number(t[2]),
      rotate: Number(t[3]),
      scale: Number(t[4]),
      opacity,
    });
  }
  return out;
}

/** Path progress per unit of time between consecutive draw stops. */
function pairwiseRates(drawBlock: string): number[] {
  const stops = stopsOf(drawBlock);
  const offsets = [
    ...withoutComments(drawBlock).matchAll(/stroke-dashoffset: (\d+(?:\.\d+)?)/g),
  ].map((m) => Number(m[1]));
  if (stops.length !== offsets.length) {
    throw new Error(`expected one dashoffset per stop, got ${stops.length}/${offsets.length}`);
  }
  const rates: number[] = [];
  for (let i = 1; i < stops.length; i += 1) {
    rates.push((offsets[i - 1]! - offsets[i]!) / (stops[i]! - stops[i - 1]!));
  }
  return rates;
}
