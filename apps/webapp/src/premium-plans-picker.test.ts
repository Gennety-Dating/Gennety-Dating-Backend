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

  it("draws no white rim on the light theme", () => {
    // A white edge held just inside a pale button on a pale page reads as a
    // frame around the fill, not as light — the same correction the ticket
    // store's recommended row needed.
    expect(token(lightBlock, "--pm-seg-on-edge")).not.toContain("255, 255, 255");
  });

  it("keeps the selection borderless — depth from fill and inset light", () => {
    // The fill and the rim moved off the cell and onto the tile that travels
    // between cells, so this is where the borderless rule now has to hold. The
    // tokens above are unchanged and still decide the polarity per theme; what
    // changed is only which element wears them.
    const thumb = rule(".pm-plan-thumb");
    expect(thumb).not.toMatch(/(^|[^-])border:/);
    expect(thumb).not.toMatch(/outline:/);
    expect(thumb).toContain("var(--pm-seg-on)");
    expect(thumb).toContain("var(--pm-seg-on-edge)");
  });

  it("leaves the chosen cell no fill of its own to stack under the tile", () => {
    // Two tints on one cell would make the selected plan a different colour
    // depending on which of the two you looked at.
    expect(rule(".pm-plan.is-selected")).toMatch(/background:\s*transparent/);
  });
});

describe("the travelling selection", () => {
  it("walks a stride the grid actually uses", () => {
    // The tile is one cell wide and steps by one cell plus one gap. Both read
    // the SAME `--pm-seg-gap`; hardcode either one and the tile lands between
    // two cells at some screen width and looks fine at every other.
    expect(rule(".pm-plans")).toContain("gap: var(--pm-seg-gap)");
    const thumb = rule(".pm-plan-thumb");
    expect(thumb).toContain("var(--pm-seg-gap)");
    expect(thumb).toMatch(/translateX\(calc\(\(100% \+ var\(--pm-seg-gap\)\) \* var\(--pm-i/);
  });

  it("moves, and moves nothing else", () => {
    // A transition on `all` here would animate the tile's width as the layout
    // settles, i.e. the selection would visibly stretch on first paint.
    const transition = /transition:\s*([^;]+);/.exec(rule(".pm-plan-thumb"))?.[1] ?? "";
    expect(transition).toContain("transform");
    expect(transition).not.toMatch(/\ball\b/);
  });

  it("shows its travelling lights only while travelling", () => {
    // A streak of speed on a parked tile is just a smear across the fill.
    for (const layer of [".pm-plan-thumb::before", ".pm-plan-thumb::after"]) {
      expect(rule(layer)).toMatch(/opacity:\s*0;/);
    }
    expect(rule(".pm-plan-thumb.is-moving::before,\n.pm-plan-thumb.is-moving::after")).toMatch(
      /opacity:\s*1;/,
    );
  });

  it("keeps the words above the tile that slides past them", () => {
    // The tile sits above the cells' fills so it can cross them; without the
    // raise it would also cross their labels.
    for (const row of [".pm-plan-head", ".pm-plan-meta"]) {
      expect(rule(row)).toContain("z-index: 2");
    }
    expect(rule(".pm-plan-thumb")).toContain("z-index: 1");
  });

  it("can hold still for a reader who asked for no motion", () => {
    const reduced = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".pm-plan-thumb");
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
    // visibly reflow every time the user compares two plans. The cell's inset
    // light is no longer in this list because the cell no longer has one — it
    // travels on `.pm-plan-thumb` now.
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
