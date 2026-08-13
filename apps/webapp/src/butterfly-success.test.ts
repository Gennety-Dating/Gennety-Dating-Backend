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
  CHECK_VERTEX,
  FLIGHT_STOPS,
  LANDED_SCALE,
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
      '<svg class="bfs-svg" viewBox="0 0 132 104" aria-hidden="true"',
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
    // BRIGHT -> DEEP, deliberately the counter-intuitive direction: deep -> bright
    // put the stroke's brightest point exactly where the butterfly lands, and the
    // logo's own magenta sits on its lower edge, so the two merged into one blob.
    expect(html).toContain('<stop offset="0%" stop-color="#C82356"/>');
    expect(html).toContain('<stop offset="100%" stop-color="#8B253B"/>');
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
  it("lands the butterfly fully inside the frame", () => {
    // An SVG crops silently, so the one thing worth arithmetic here is that the
    // landed wingtip clears the viewBox rather than being trimmed on someone's
    // screen and nobody's review.
    const halfWidth = (WING_BBOX.width * LANDED_SCALE) / 2;
    const halfHeight = (WING_BBOX.height * LANDED_SCALE) / 2;
    expect(CHECK_END.x + halfWidth).toBeLessThan(132);
    expect(CHECK_END.x - halfWidth).toBeGreaterThan(0);
    expect(CHECK_END.y + halfHeight).toBeLessThan(104);
    expect(CHECK_END.y - halfHeight).toBeGreaterThan(0);
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
    const flight = keyframeBlock(CSS, "bfs-flight");
    const draw = keyframeBlock(CSS, "bfs-draw");
    expect(stopsOf(flight)).toEqual([...FLIGHT_STOPS]);
    expect(stopsOf(draw)).toEqual([...FLIGHT_STOPS]);
  });

  it("keeps both halves linear, so the acceleration lives in the stop spacing", () => {
    // An easing curve would have to be applied identically to a transform and to
    // a dashoffset to stay in step; spacing cannot drift the way two curves can.
    expect(CSS).toMatch(/animation: bfs-flight 900ms linear both/);
    expect(CSS).toMatch(/animation: bfs-draw 900ms linear both/);
  });

  it("actually accelerates into the dive and decelerates into the landing", () => {
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

  it("comes to rest upright — the closing frame is the logo's own silhouette", () => {
    expect(keyframeBlock(CSS, "bfs-flight")).toContain(
      `transform: translate(${CHECK_END.x}px, ${CHECK_END.y}px) rotate(0deg) scale(${LANDED_SCALE})`,
    );
  });

  it("grows the butterfly monotonically, never shrinking mid-flight", () => {
    // Regression guard, and a real one: rescaling this curve by hand produced a
    // sequence where the vertex was momentarily LARGER than the frame after it,
    // i.e. the butterfly flew toward the viewer and then backed off in the middle
    // of the sweep. Perspective that reverses reads as a glitch, not as depth.
    const block = withoutComments(keyframeBlock(CSS, "bfs-flight"));
    const scales = [...block.matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(scales).toHaveLength(FLIGHT_STOPS.length);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
    expect(scales.at(-1)).toBe(LANDED_SCALE);
  });

  it("keeps one size knob, with the aspect derived from the viewBox", () => {
    // Setting a width and a height independently is how the tick gets squashed;
    // the ratio is the viewBox's, so it is not a free parameter.
    expect(CSS).toContain("--bfs-w:");
    expect(ruleBlock(CSS, ".bfs-svg")).toContain("height: calc(var(--bfs-w) * 104 / 132)");
    expect(ruleBlock(CSS, ".bfs-mark")).toContain("height: calc(var(--bfs-w) * 104 / 132)");
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

  it("stops all travel under prefers-reduced-motion but keeps the finished mark", () => {
    const block = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation: none");
    // Landed pose and a drawn stroke — not a butterfly frozen at its entry point.
    expect(block).toContain(
      `transform: translate(${CHECK_END.x}px, ${CHECK_END.y}px) rotate(0deg) scale(${LANDED_SCALE})`,
    );
    expect(block).toContain("stroke-dashoffset: 0");
    // The success still ARRIVES rather than being there as if nothing changed.
    expect(block).toContain("animation: bfs-fade-in");
  });

  it("bases the un-animated state on the LANDED pose, not the entry pose", () => {
    // This is what reduced motion falls back to, and what a frame between mount
    // and animation start shows. Basing it on the entry pose would flash a tiny
    // butterfly in the wrong corner with no stroke at all.
    expect(ruleBlock(CSS, ".bfs-fly")).toContain(
      `transform: translate(${CHECK_END.x}px, ${CHECK_END.y}px) rotate(0deg) scale(${LANDED_SCALE})`,
    );
    expect(ruleBlock(CSS, ".bfs-trail")).toContain("stroke-dashoffset: 0");
    // And the wings' base is open, so the resting silhouette is the logo's.
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
  it("matches the stylesheet's flight duration", () => {
    // The constant's other job is telling self-dismissing screens when the
    // landing happens, so a drift here closes a WebView over a half-drawn tick.
    expect(CSS).toContain(`${SUCCESS_FLIGHT_MS}ms linear both`);
  });

  it("covers the bloom and caption that settle after the landing", () => {
    // The bloom starts at 760ms and runs 520ms → rest at 1280ms; the caption
    // starts at 820ms over 380ms → 1200ms. TOTAL must not be shorter than the
    // last thing still moving, or a self-dismissing screen cuts it off.
    const bloomEnd = 760 + 520;
    expect(SUCCESS_TOTAL_MS).toBe(SUCCESS_FLIGHT_MS + SUCCESS_SETTLE_MS);
    expect(SUCCESS_TOTAL_MS).toBeGreaterThanOrEqual(bloomEnd - 40);
    expect(CSS).toContain("animation: bfs-bloom 520ms ease-out 760ms both");
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
