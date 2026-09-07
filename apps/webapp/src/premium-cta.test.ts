import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a Node
// builtin would break `pnpm typecheck` even though vitest runs it happily.
// Non-empty only because vite.config.ts lists this stylesheet in
// `test.css.include` — vitest stubs CSS imports otherwise.
import CSS from "./premium.css?raw";
// The screen's own source, as text. `premium.ts` cannot be imported (it calls
// `WebApp.ready()` and `load()` on import), but one guard below needs to see a
// colour it hardcodes for Telegram's chrome — the same precedent as reading
// verification.html to check its inlined copy of shared keyframes.
import TS from "./premium.ts?raw";
import { ctaLabel, ctaTerms, type CtaCopy } from "./premium-cta-label";

/**
 * The Premium CTA after the footer was slimmed (§3.8).
 *
 * Two changes made this file necessary, and neither is visible to a typecheck,
 * to the picker's own tests, or to a screenshot:
 *
 *  1. **The button states a monthly RATE, so it can state a wrong one.** The
 *     3/6-month cells no longer print their totals — the button and the terms
 *     line are the only places the sum survives. The failure mode is silent and
 *     expensive: suffix a package's TOTAL with "/mo" and the screen offers a
 *     $75.56 charge under a $12.59 label.
 *  2. **The pill's light stopped being ambient and became a response.** The
 *     breathing bloom was removed; the press specular is placed from the touch
 *     point. A later edit that "restores the glow" by reinstating an infinite
 *     animation, or that recentres the highlight, undoes the whole point and
 *     still renders perfectly.
 */

/** The body of a CSS rule, comments stripped — prose must not satisfy a guard. */
function rule(selector: string): string {
  const at = CSS.indexOf(selector + " {");
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Copy that reports which branch was taken, in the shape the screen uses. */
const COPY: CtaCopy = {
  subscribe: (p) => `Subscribe — ${p}/mo`,
  buyPackage: (p) => `Get Premium — ${p}`,
  planOneOff: (t) => `${t} once · no auto-renewal`,
  price: (p) => `${p}/month · cancel anytime`,
};

const MONTHLY = { recurring: true, perMonthDisplay: "$17.99" };
const PACKAGE = { recurring: false, perMonthDisplay: "$12.59" };
/** What the server sends when the configured price display has no amount. */
const NO_RATE = { recurring: false, perMonthDisplay: null };

describe("the button's price", () => {
  it("states the monthly rate for a package, not its total", () => {
    expect(ctaLabel(COPY, PACKAGE, "$75.56")).toBe("Subscribe — $12.59/mo");
  });

  it("states the monthly plan's own price, which is already a rate", () => {
    expect(ctaLabel(COPY, MONTHLY, "$17.99")).toBe("Subscribe — $17.99/mo");
  });

  it("NEVER puts a rate suffix on a total when no rate exists", () => {
    // The one lie this screen cannot tell: "$75.56/mo" on the button that
    // charges $75.56 once. Without a rate, a package states its total plainly.
    const label = ctaLabel(COPY, NO_RATE, "$75.56");
    expect(label).toBe("Get Premium — $75.56");
    expect(label).not.toContain("/mo");
  });

  it("falls back to the screen-level price when no plan is selected", () => {
    expect(ctaLabel(COPY, null, "$17.99")).toBe("Subscribe — $17.99/mo");
  });
});

describe("the terms line under the button", () => {
  it("carries the total the package actually charges", () => {
    // The cells stopped printing it and the button now says a rate, so this is
    // the last place the sum is legible before the invoice opens.
    expect(ctaTerms(COPY, PACKAGE, "$75.56")).toContain("$75.56");
  });

  it("still says the total even when the rate is missing", () => {
    expect(ctaTerms(COPY, NO_RATE, "$75.56")).toContain("$75.56");
  });

  it("keeps the recurring plan's line about renewal, not a one-off sum", () => {
    const line = ctaTerms(COPY, MONTHLY, "$17.99");
    expect(line).toContain("cancel anytime");
    expect(line).not.toContain("once");
  });
});

describe("the pill's light", () => {
  it("does not breathe at rest — no ambient animation on the CTA", () => {
    // Ambient motion plays whether or not anyone is watching; within seconds it
    // is wallpaper. The resting bloom is held still on purpose.
    expect(rule(".pm-cta")).not.toContain("animation");
    expect(rule(".pm-cta::before")).not.toContain("animation");
    expect(CSS).not.toContain("@keyframes pm-cta-glow");
  });

  it("puts the press highlight where the finger is, not in the middle", () => {
    const press = rule(".pm-cta::after");
    expect(press).toContain("var(--pm-px)");
    expect(press).toContain("var(--pm-py)");
  });

  it("rises faster than it drains", () => {
    // Light leaving glass, not a state switching off: a symmetric fade reads as
    // a toggle. The rest state owns the long duration; the pressed state
    // shortens it.
    const restMs = /transition:\s*opacity\s*(\d+)ms/.exec(rule(".pm-cta::after"))?.[1];
    const pressMs = /transition-duration:\s*(\d+)ms/.exec(
      rule(".pm-cta.is-pressed::after,\n.pm-cta:active::after"),
    )?.[1];
    expect(Number(pressMs)).toBeLessThan(Number(restMs));
  });

  it("presses INTO the page — the cast shadow collapses with the scale", () => {
    // A scale on its own reads as a picture being made smaller.
    const pressed = rule(".pm-cta.is-pressed,\n.pm-cta:active");
    expect(pressed).toContain("transform");
    expect(pressed).toContain("box-shadow");
  });
});

describe("the slimmed footer", () => {
  it("gives a plan cell one price line, never a second smaller one", () => {
    // The stacked total was ~13px of a `flex: none` footer per cell, and it was
    // the number that made the 6-month plan look like the expensive one.
    expect(CSS).not.toContain(".pm-plan-permonth");
  });
});

describe("the action bar's glass", () => {
  it("has something behind it to blur", () => {
    // The whole difference between glass and a painted gradient. The bar is out
    // of flow so the scroller runs underneath it; put it back in the flex column
    // and `backdrop-filter` samples the page's own flat background — the blur
    // still "works", and nothing looks any different, which is how this would
    // get quietly undone.
    const action = rule(".pm-action");
    expect(action).toMatch(/position:\s*absolute/);
    expect(action).toContain("backdrop-filter");
  });

  it("keeps the scroller clear of the bar it no longer displaces", () => {
    // An absolute bar reserves no space. Without this pad the referral chip —
    // the last thing in the scroll — sits behind the glass with no way to reach
    // it, on a screen whose whole job is to be scrolled to the end.
    expect(rule(".pm-scroll")).toContain("var(--pm-footer-h");
  });

  it("puts back the colour the blur drains", () => {
    expect(rule(".pm-action")).toMatch(/saturate\(\s*1[5-9]\d%\s*\)/);
  });

  it("falls back to an opaque bar where backdrop-filter is unsupported", () => {
    // Translucent with no blur is not a softer version of this material, it is a
    // wash with the page legible straight through the button.
    expect(CSS).toContain("@supports not ((backdrop-filter");
  });
});

describe("the light theme's separation", () => {
  const lightBlock = CSS.slice(CSS.indexOf(':root[data-theme="light"]'));

  /** The value of a custom property inside a block of the stylesheet. */
  function token(block: string, name: string): string {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
    expect(m, `${name} not defined in that block`).not.toBeNull();
    return m![1].trim();
  }

  it("stands the page off the white cards it carries", () => {
    // The complaint this exists for: white cards on a #f5f5f5 page are a 4% step
    // — not enough to tell one surface from the next, so the screen reads as one
    // bright field. The ground has to sit measurably below #ffffff.
    const bg = token(lightBlock, "--bg");
    const channel = parseInt(bg.slice(1, 3), 16);
    expect(channel).toBeLessThanOrEqual(0xf0);
  });

  it("keeps Telegram's chrome on the same ground as the page", () => {
    // Two files carry this colour: the stylesheet paints the page, and
    // `chromeColor` in premium.ts tells Telegram what to paint its header and
    // bottom bar. A drift shows as a paler strip at both ends of the screen.
    expect(TS).toContain(token(lightBlock, "--bg"));
  });

  it("lifts the cards on light and leaves the dark page alone", () => {
    // Depth, not ink: a white card gets its edge from the shadow under it. On
    // the near-black page the same shadow would only smear #030303.
    expect(token(lightBlock, "--pm-card-lift")).toContain("rgba(0, 0, 0, 0.0");
    const darkBlock = CSS.slice(0, CSS.indexOf(':root[data-theme="light"]'));
    expect(token(darkBlock, "--pm-card-lift")).toMatch(/0 0 0 rgba\(0, 0, 0, 0\)/);
  });

  it("gives an unselected plan chip an edge of its own", () => {
    // The chips sit ON the footer glass now. An untinted chip and the pane
    // behind it are the same brightness on cream — three of them dissolve into
    // the panel without one.
    expect(rule(".pm-plan")).toContain("var(--pm-seg-edge)");
    expect(token(lightBlock, "--pm-seg-edge")).toContain("0, 0, 0");
  });
});
