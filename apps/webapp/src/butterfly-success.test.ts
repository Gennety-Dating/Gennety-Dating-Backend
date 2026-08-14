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
  POP_PEAK_SCALE,
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
 * cannot cross — which is how this helper first failed to see `bfs-pop` at all.
 * Lazy up to the fill mode, so it stops inside its own comma-separated entry.
 */
function animation(name: string): { duration: number; delay: number } {
  const match = new RegExp(`${name}\\s+(\\d+)ms([\\s\\S]*?)(?:both|infinite)`).exec(CSS);
  if (!match) throw new Error(`no animation shorthand for ${name} in the stylesheet`);
  const delay = [...(match[2] ?? "").matchAll(/(\d+)ms/g)].at(-1)?.[1];
  return { duration: Number(match[1]), delay: Number(delay ?? 0) };
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
    // is the common one — and without a tick the mark says "Gennety" rather than
    // "success", so the announcement is the only thing carrying the outcome.
    expect(butterflySuccessMarkup({ ariaLabel: "Verified" })).toContain('aria-label="Verified"');
  });

  it("hides the drawing from assistive tech — the wrapper is the announced part", () => {
    expect(butterflySuccessMarkup({ label: "x" })).toContain(
      `viewBox="${-VIEWBOX.width / 2} ${-VIEWBOX.height / 2} ${VIEWBOX.width} ${VIEWBOX.height}"`,
    );
    expect(butterflySuccessMarkup({ label: "x" })).toContain('aria-hidden="true"');
  });

  it("draws ONE butterfly, and no waist", () => {
    // One, not the loader's three, and no belly: the loader is butterflies inside
    // a waist (nerves), this one is the single butterfly, arrived.
    const html = butterflySuccessMarkup();
    expect(html.match(/class="bfs-fly"/g)).toHaveLength(1);
    expect(html.match(/<path /g)).toHaveLength(2);
    expect(html).not.toContain("belly");
  });

  it("carries no checkmark of any kind", () => {
    // The decision this mark turned on. A tick here would duplicate the sentence
    // every one of these screens already prints beside it, and both earlier
    // versions of the mark died trying to make one work.
    const html = butterflySuccessMarkup();
    expect(html).not.toContain("bfs-trail");
    expect(html).not.toContain("pathLength");
    expect(html).not.toContain("stroke");
    expect(CSS).not.toContain("stroke-dashoffset");
  });

  it("paints from an attribute, so a late stylesheet cannot render it unpainted", () => {
    expect(butterflySuccessMarkup()).toContain('fill="url(#gnt-bfs-wing)"');
    expect(CSS).not.toMatch(/fill:\s*url\(/);
  });

  it("uses the shared logo gradient rather than a copy of it", () => {
    // The whole point of brand-butterfly.ts. A hand-copied gradient is how this
    // mark drifts from the logo one edit at a time — which is exactly what the
    // radius did before it was corrected to the normalised diagonal.
    expect(butterflySuccessMarkup()).toContain(logoWingGradient("gnt-bfs-wing"));
  });
});

describe("geometry", () => {
  it("contains the butterfly at its largest, so the frame cannot crop a wing", () => {
    // An SVG crops silently and a clipped wing is a hard straight cut that reads
    // as a rendering fault. The arrival overshoots past 1, so the peak — not the
    // resting size — is what the viewBox has to clear.
    const halfW = (WING_BBOX.width / 2) * POP_PEAK_SCALE;
    const halfH = (WING_BBOX.height / 2) * POP_PEAK_SCALE;
    expect(halfW).toBeLessThan(VIEWBOX.width / 2);
    expect(halfH).toBeLessThan(VIEWBOX.height / 2);
  });

  it("never scales anything past the arrival's peak", () => {
    // What makes ONE constant bound the whole animation, and therefore what
    // makes the crop guard above cover the largest frame rather than one of
    // several. The breath and the bloom both stay under it today; if either
    // ever grows past, this fails before the wing is silently clipped.
    const peaks = [...CSS.matchAll(/scale\((1\.\d+)\)/g)].map((m) => Number(m[1]));
    expect(peaks.length).toBeGreaterThan(1);
    expect(Math.max(...peaks)).toBeCloseTo(POP_PEAK_SCALE, 3);
  });

  it("derives the rendered box from the viewBox, so the mark cannot be squashed", () => {
    expect(CSS).toContain(`calc(var(--bfs-w) * ${VIEWBOX.height} / ${VIEWBOX.width})`);
  });
});

describe("timing", () => {
  it("fires the haptic when the butterfly lands, not when the bloom finishes", () => {
    expect(animation("bfs-pop").duration).toBe(SUCCESS_ARRIVE_MS);
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

  it("starts the breath only after the arrival has landed", () => {
    // Both animate `transform` on the same element, so the later declaration
    // wins the property. Starting the breath early freezes the mark at the
    // breath's first keyframe instead of letting it arrive.
    const breath = animation("bfs-breath");
    expect(breath.delay).toBeGreaterThanOrEqual(SUCCESS_ARRIVE_MS);
    expect(CSS.indexOf("bfs-breath 3200ms")).toBeGreaterThan(CSS.indexOf("bfs-pop"));
  });

  it("clamps a mark whose success arrived late", () => {
    // Verification renders the mark and THEN waits on the network, so by the
    // time it wants to buzz the arrival is often already over.
    expect(settleDelayFrom(1000, 1200)).toBe(SUCCESS_ARRIVE_MS - 200);
    expect(settleDelayFrom(1000, 9000)).toBe(0);
    expect(restDelayFrom(1000, 9000)).toBe(0);
  });
});

describe("reduced motion", () => {
  it("rests on the FINAL pose, so no keyframe has to be restated", () => {
    // The base values are the arrived ones, which is what makes killing the
    // animations sufficient. Restating them was the old bug: a second copy of
    // the landed transform that had to be kept in step by hand.
    const fly = /\.bfs-fly\s*{([^}]*)}/.exec(CSS)?.[1] ?? "";
    expect(fly).toContain("transform: scale(1)");
    expect(fly).toContain("opacity: 1");
  });

  it("kills every animation but still lets the success arrive", () => {
    const block = CSS.slice(CSS.indexOf("prefers-reduced-motion"));
    for (const sel of [".bfs-fly", ".bfs-mark::before", ".bfs-label"]) {
      expect(block, `${sel} keeps animating under reduced motion`).toContain(sel);
    }
    expect(block).toContain("animation: none");
    // Not "appears as though the screen never changed".
    expect(block).toContain("bfs-fade-in");
  });
});

describe("onSuccessSettle", () => {
  it("pulses when the butterfly lands", () => {
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
