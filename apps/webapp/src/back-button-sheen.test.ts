import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest runs it happily.
// The stylesheet is non-empty only because vite.config.ts lists it in
// `test.css.include` — vitest stubs CSS imports otherwise.
import RAW from "./onboarding.css?raw";

/**
 * Comments are stripped before anything is asserted. Without that, a `[data-
 * theme]` written in prose — this file's own doc comment says the words — is
 * indistinguishable from a selector, and the theme check below passes or fails
 * on what someone wrote ABOUT the button rather than on what targets it.
 */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The back arrow on the last onboarding screens (`.howitworks-back`, the one
 * that pages the how-it-works sub-steps and the date-flow walkthrough).
 *
 * It carries the house inner-edge sheen: light sprayed from the border INWARD,
 * on a graphite fill, with no stroke. Three properties hold that up, and each
 * is structural rather than a matter of taste — which is why they are pinned
 * here instead of trusted to a screenshot:
 *
 * 1. EVERY directional inset carries a NEGATIVE spread. That negative spread
 *    is the whole mechanism: it pulls the shadow's own body back past the edge
 *    so only the soft falloff survives just inside the rim. At zero or positive
 *    spread the same declaration is an ordinary inner shadow — a vignette
 *    pressing in from the edge, which is the opposite reading.
 * 2. No `inset 0 0 0 1px` ring. That hairline is a stroke, and the button is
 *    meant to be borderless; it also competes with the sheen for the same few
 *    pixels of rim. (Rule 1 already forbids it — a ring needs a POSITIVE
 *    spread to exist — so this is the same invariant stated where a reader
 *    will look for it.)
 * 3. The fill is dark on BOTH themes, and no `[data-theme]` rule may override
 *    the button. Light bleeding inward has nothing to bleed into on a pale
 *    fill, so a light-theme "fix" would delete the effect on the cream page
 *    rather than adapt it. Same reasoning as `--pref-both-bg`, which is black
 *    in both themes for exactly this reason.
 */

/** The value of a custom property declared on `:root`, as authored. */
function token(name: string): string {
  const m = new RegExp(`${name}\\s*:([^;]*);`).exec(CSS);
  if (!m) throw new Error(`no ${name} token in onboarding.css`);
  return m[1]!;
}

/** The `{ … }` body of a single rule, as authored. */
function rule(selector: string): string {
  const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!m) throw new Error(`no ${selector} rule in onboarding.css`);
  return m[1]!;
}

/**
 * The inset entries of a box-shadow list, split on the commas that separate
 * shadows rather than the ones inside `rgba(...)`.
 */
function insetShadows(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.startsWith("inset"));
}

/** The px lengths of one shadow, in author order: x, y, blur, spread. */
function lengths(shadow: string): number[] {
  const head = shadow.slice(0, shadow.search(/rgba?\(|#/));
  return (head.match(/-?\d+(?:\.\d+)?px|(?<![\w.-])0(?![\w.])/g) ?? []).map(Number.parseFloat);
}

const SHEEN_TOKENS = ["--back-sheen", "--back-sheen-lit"] as const;

describe("onboarding back arrow — inner-edge sheen", () => {
  it.each(SHEEN_TOKENS)("%s sprays light inward from all four edges", (name) => {
    const directional = insetShadows(token(name)).filter((s) => lengths(s).length === 4);

    // Top, bottom, left, right. Fewer than four and the light stops reading as
    // coming from the border — it becomes a highlight on one side.
    expect(directional.length).toBeGreaterThanOrEqual(4);

    for (const shadow of directional) {
      const spread = lengths(shadow)[3]!;
      expect(spread, `spread must be negative in "${shadow.trim()}"`).toBeLessThan(0);
    }
  });

  it.each(SHEEN_TOKENS)("%s draws no ring around the button", (name) => {
    // A stroke is `inset 0 0 0 <positive>`: no offset, no blur, spread only.
    for (const shadow of insetShadows(token(name))) {
      const [x, y, blur, spread] = lengths(shadow);
      const isRing = x === 0 && y === 0 && blur === 0 && (spread ?? 0) > 0;
      expect(isRing, `"${shadow.trim()}" is a ring, not edge light`).toBe(false);
    }
  });

  it("fills the button with graphite dark enough for inward light to read", () => {
    const hex = token("--back-graphite").trim();
    expect(hex).toMatch(/^#[0-9a-f]{6}$/i);

    const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const brightest = Math.max(...channels);
    // Graphite, not merely "darker than white". Above ~0.2 the fill starts
    // reflecting as much as the sheen adds and the effect flattens out.
    expect(brightest / 255).toBeLessThan(0.2);
  });

  it("uses the same graphite and the same sheen on both themes", () => {
    // No theme-scoped rule may target the button...
    expect(CSS).not.toMatch(/\[data-theme[^{]*\.howitworks-back/);
    // ...and the tokens it reads must be declared exactly once, so a theme
    // block cannot redefine them out from under it either.
    for (const name of [...SHEEN_TOKENS, "--back-graphite"]) {
      const declarations = CSS.match(new RegExp(`${name}\\s*:`, "g")) ?? [];
      expect(declarations, `${name} is redeclared`).toHaveLength(1);
    }
  });

  it("reads its fill and sheen from those tokens", () => {
    const base = rule(".howitworks-back");
    expect(base).toMatch(/background:\s*var\(--back-graphite\)/);
    expect(base).toMatch(/box-shadow:\s*var\(--back-sheen\)/);
    // Borderless at the border property too, not only in the shadow list.
    expect(base).toMatch(/border:\s*0/);
  });
});
