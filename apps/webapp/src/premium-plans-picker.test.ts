import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest runs it happily.
// Non-empty only because vite.config.ts lists this stylesheet in
// `test.css.include` — vitest stubs CSS imports otherwise.
import CSS from "./premium.css?raw";

/**
 * The 1 / 3 / 6-month plan picker (§3.8).
 *
 * Two properties are worth holding, and neither is visible to a typecheck, a
 * unit test, or a screenshot taken on one theme:
 *
 *  1. **The selected cell is always MORE present than its neighbours.** The
 *     obvious implementation reuses `--pm-glass-fill` for the selected state,
 *     which is a WHITE gradient — correct on the near-black page, and inverted
 *     on cream, where it renders the chosen plan whiter than the background
 *     while the unselected ones carry an ink tint. The control then reads back
 *     to front. Measured on the real render before the fix.
 *  2. **The cells are equal width.** `repeat(3, 1fr)` is `minmax(auto, 1fr)`,
 *     so the longest label widens its own cell: measured 101 / 113 / 122px in
 *     Russian. Unequal cells read as three separate objects rather than one
 *     control, and the widths shift per locale.
 */

/** The body of a CSS rule, comments stripped — prose must not satisfy a guard. */
function rule(selector: string): string {
  const at = CSS.indexOf(selector + " {");
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The value of a custom property inside a given block of the stylesheet. */
function token(block: string, name: string): string {
  const re = new RegExp(`${name}:\\s*([^;]+);`);
  const m = re.exec(block);
  expect(m, `${name} not defined in that block`).not.toBeNull();
  return m![1].trim();
}

/** Mean alpha of every rgba() in a value — how much the fill covers the page. */
function meanAlpha(value: string): number {
  const alphas = [...value.matchAll(/rgba\([^)]*?,\s*([\d.]+)\s*\)/g)].map((m) =>
    Number(m[1]),
  );
  expect(alphas.length, `no rgba() in "${value}"`).toBeGreaterThan(0);
  return alphas.reduce((a, b) => a + b, 0) / alphas.length;
}

const darkBlock = CSS.slice(
  CSS.indexOf(':root[data-theme="dark"]'),
  CSS.indexOf(':root[data-theme="light"]'),
);
const lightBlock = CSS.slice(CSS.indexOf(':root[data-theme="light"]'));

describe("the plan picker's selection polarity", () => {
  it("is defined once per theme, not inherited from the shared glass tokens", () => {
    for (const block of [darkBlock, lightBlock]) {
      expect(token(block, "--pm-seg")).toBeTruthy();
      expect(token(block, "--pm-seg-on")).toBeTruthy();
    }
  });

  it("makes the selected cell BRIGHTER than its neighbours on dark", () => {
    const off = token(darkBlock, "--pm-seg");
    const on = token(darkBlock, "--pm-seg-on");
    expect(off).toContain("255, 255, 255");
    expect(on).toContain("255, 255, 255");
    expect(meanAlpha(on)).toBeGreaterThan(meanAlpha(off));
  });

  it("makes the selected cell MORE TINTED than its neighbours on light", () => {
    const off = token(lightBlock, "--pm-seg");
    const on = token(lightBlock, "--pm-seg-on");
    // Ink, not white. A white fill here is the inversion this guard exists for:
    // it would make the chosen plan disappear into the page.
    expect(off).toContain("0, 0, 0");
    expect(on).toContain("0, 0, 0");
    expect(on).not.toContain("255, 255, 255");
    expect(meanAlpha(on)).toBeGreaterThan(meanAlpha(off));
  });

  it("draws NO rim around the chosen cell — not a border, not an inset ring", () => {
    // Founder call, and the strongest wording of the session: a lit ring around
    // the selection "looks cheap, really cheap". `inset 0 0 0 1px` is a frame
    // however softly it is lit, so the whole rim token is gone rather than
    // merely dimmed — a dimmer frame is still a frame, and this is exactly the
    // shape a later "let's give it a subtle edge" would take.
    const selected = rule(".pm-plan.is-selected");
    expect(selected).not.toMatch(/(^|[^-])border:/);
    expect(selected).not.toMatch(/outline:/);
    expect(selected).not.toContain("box-shadow");
    expect(CSS).not.toContain("--pm-seg-on-edge");
  });

  it("tells the chosen cell apart with light alone", () => {
    // What is left once the outline is gone, and all three are made of light:
    // a brighter fill, the clouds drifting inside it, and a full-ink label.
    const selected = rule(".pm-plan.is-selected");
    expect(selected).toContain("var(--pm-seg-on)");
    expect(selected).toContain("var(--pm-ink)");
  });
});

describe("the clouds inside the chosen cell", () => {
  it("burns only on the cell that was chosen", () => {
    // The whole justification for ambient motion on this screen — which argues
    // against it one control below, on the CTA. It is allowed here because it is
    // not decorating anything: it IS the selected state, it exists on exactly
    // one of three cells, and it ends when that cell stops being the choice.
    for (const layer of [".pm-plan::before,\n.pm-plan::after"]) {
      expect(rule(layer)).toMatch(/opacity:\s*0;/);
    }
    expect(rule(".pm-plan.is-selected::before,\n.pm-plan.is-selected::after")).toMatch(
      /opacity:\s*1;/,
    );
  });

  it("does not animate the two cells nobody chose", () => {
    // Hidden is not enough: a paused animation costs nothing, a running one
    // behind `opacity: 0` costs a composited layer per cell, forever.
    expect(rule(".pm-plan::before,\n.pm-plan::after")).toContain("animation-play-state: paused");
    expect(rule(".pm-plan.is-selected::before,\n.pm-plan.is-selected::after")).toContain(
      "animation-play-state: running",
    );
  });

  it("gives the two layers periods that do not divide each other", () => {
    // Equal (or halved) periods put the layers back into the same arrangement
    // every cycle, and the eye finds that loop within seconds — which is exactly
    // when drifting weather turns back into a spinning GIF.
    // Read from the whole sheet, not through `rule()`: the grouped
    // `.pm-plan::before,\n.pm-plan::after` selector CONTAINS ".pm-plan::after {"
    // as a substring, so the helper's `indexOf` hands back the grouped block
    // instead of the standalone one. Each animation name appears in exactly one
    // shorthand, which makes this unambiguous.
    const a = Number(/animation:\s*pm-cloud-a\s+(\d+)s/.exec(CSS)?.[1]);
    const b = Number(/animation:\s*pm-cloud-b\s+(\d+)s/.exec(CSS)?.[1]);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(b % a).not.toBe(0);
    expect(a % b).not.toBe(0);
  });

  it("moves nothing but a transform", () => {
    // `filter` or `background-position` here would repaint the cell every frame
    // for the entire time a plan is selected, which on this screen is always.
    for (const frames of ["@keyframes pm-cloud-a", "@keyframes pm-cloud-b"]) {
      const at = CSS.indexOf(frames);
      expect(at, `${frames} not found`).toBeGreaterThan(-1);
      const body = CSS.slice(at, CSS.indexOf("\n}", at));
      expect(body).not.toContain("filter:");
      expect(body).not.toContain("background-position");
      expect(body).toContain("translate3d");
    }
  });

  it("drifts wider than the cell it is clipped to", () => {
    // A cloud whose own falloff drifts into view stops being a cloud and starts
    // being an ellipse. The layer is half again bigger than the cell in every
    // direction, and the cell clips it.
    const inset = /inset:\s*(-?\d+)%/.exec(rule(".pm-plan::before,\n.pm-plan::after"))?.[1];
    expect(Number(inset)).toBeLessThanOrEqual(-30);
    expect(rule(".pm-plan")).toContain("overflow: hidden");
  });

  it("lights the cell on dark and DEEPENS it on cream", () => {
    // Same rule as every other mark on this screen: on the light theme the
    // chosen cell is the darkest one, so what drifts inside it must be ink.
    // White clouds there would read as holes punched through the chip.
    expect(token(darkBlock, "--pm-cloud-a")).toContain("255, 255, 255");
    expect(token(darkBlock, "--pm-cloud-b")).toContain("255, 255, 255");
    expect(token(lightBlock, "--pm-cloud-a")).toContain("0, 0, 0");
    expect(token(lightBlock, "--pm-cloud-b")).toContain("0, 0, 0");
    expect(token(lightBlock, "--pm-cloud-a")).not.toContain("255");
  });

  it("keeps the words above the weather", () => {
    // A bright mass drifting across the price would take the price with it.
    for (const row of [".pm-plan-head", ".pm-plan-meta"]) {
      expect(rule(row)).toContain("z-index: 2");
    }
    expect(rule(".pm-plan::before,\n.pm-plan::after")).toContain("z-index: 0");
  });

  it("holds still — but stays visible — for a reader who asked for no motion", () => {
    // Freezing them is right; hiding or dimming them would take the answer to
    // "which plan is chosen" away with the motion.
    const reduced = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    const at = reduced.indexOf(".pm-plan::before,\n  .pm-plan::after");
    expect(at, "the clouds are not frozen under reduced motion").toBeGreaterThan(-1);
    expect(reduced.slice(at, at + 200)).toContain("animation: none");
    expect(reduced.slice(at, at + 200)).not.toContain("opacity");
  });
});

describe("the plan picker's layout", () => {
  it("gives the three cells equal width", () => {
    const plans = rule(".pm-plans");
    expect(plans).toContain("minmax(0, 1fr)");
    // Bare `1fr` is `minmax(auto, 1fr)` — the trap this replaced.
    expect(plans).not.toMatch(/grid-template-columns:\s*repeat\(3,\s*1fr\)/);
  });

  it("animates only the fill and the label, never the layout", () => {
    // A transition on `all` would also animate padding/gap and make the row
    // visibly reflow every time the user compares two plans.
    const cell = rule(".pm-plan");
    const transition = /transition:\s*([^;]+);/.exec(cell)?.[1] ?? "";
    expect(transition).toContain("background");
    expect(transition).toContain("color");
    expect(transition).not.toMatch(/\ball\b/);
  });

  it("stands the unselected labels back from the chosen one", () => {
    // Two states, two inks. Reading them off the same token would leave the
    // fill as the only signal, and at these alphas the fill is the quiet half.
    expect(rule(".pm-plan")).toContain("color: var(--pm-ink-soft)");
    expect(rule(".pm-plan.is-selected")).toContain("color: var(--pm-ink)");
  });
});
