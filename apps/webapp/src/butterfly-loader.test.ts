import { describe, expect, it } from "vitest";
// Vite's `?raw` rather than `node:fs`: this package compiles with `types: []`
// (browser-only), so a Node builtin import would break `pnpm typecheck` even
// though vitest would happily run it. Same reasoning as liveness-theme.test.ts.
// Note the CSS one only arrives non-empty because vite.config.ts lists this
// stylesheet in `test.css.include` — vitest stubs CSS imports by default.
import CSS from "./butterfly-loader.css?raw";
import VERIFICATION_HTML from "../verification.html?raw";
import { butterflyLoaderMarkup } from "./butterfly-loader";

describe("butterflyLoaderMarkup", () => {
  it("labels the live region and escapes the caption", () => {
    const html = butterflyLoaderMarkup({ label: `Rock & <b>roll</b> "now"` });
    expect(html).toContain('role="status"');
    expect(html).toContain("Rock &amp; &lt;b&gt;roll&lt;/b&gt; &quot;now&quot;");
    expect(html).not.toContain("<b>roll</b>");
  });

  it("omits the caption entirely when no label is given", () => {
    expect(butterflyLoaderMarkup()).not.toContain("bfl-label");
  });

  it("still announces a state when the mark carries no visible caption", () => {
    expect(butterflyLoaderMarkup({ ariaLabel: "Loading" })).toContain('aria-label="Loading"');
  });

  it("hides the drawing from assistive tech — the wrapper is the announced part", () => {
    expect(butterflyLoaderMarkup({ label: "x" })).toContain('<svg class="bfl-svg" viewBox="0 0 120 132" aria-hidden="true"');
  });

  it("draws exactly three butterflies, each with two independently flapping wings", () => {
    const html = butterflyLoaderMarkup();
    expect(html.match(/class="bfl-fly bfl-fly--\d"/g)).toHaveLength(3);
    expect(html.match(/class="bfl-wing"/g)).toHaveLength(6);
  });

  it("keeps the logo's single gradient across both split wings", () => {
    // The wings are separate paths, so an objectBoundingBox gradient would
    // restart at each one and turn the butterfly symmetric. userSpaceOnUse over
    // the whole-butterfly bbox is what preserves the logo's off-centre glow.
    const html = butterflyLoaderMarkup();
    expect(html).toContain('gradientUnits="userSpaceOnUse"');
    // Same four stops, in the same order, as apps/bot/src/assets/brand/butterfly-logo.svg.
    expect(html).toContain('<stop offset="0%" stop-color="#FF00FF"/>');
    expect(html).toContain('<stop offset="30%" stop-color="#C82356"/>');
    expect(html).toContain('<stop offset="70%" stop-color="#8B253B"/>');
    expect(html).toContain('<stop offset="100%" stop-color="#3B0B1E"/>');
  });
});

// `butterflyLoader()` (the DOM-node flavour) is deliberately untested: it is
// three lines around `butterflyLoaderMarkup`, and the webapp suite runs without
// a DOM — pulling in jsdom just to assert `firstElementChild` would be a new
// dependency for no coverage that the markup tests above don't already give.

describe("stylesheet", () => {
  it("defines every animation the markup relies on", () => {
    for (const name of ["bfl-drift-1", "bfl-drift-2", "bfl-drift-3", "bfl-flap", "bfl-breathe", "bfl-bloom"]) {
      expect(CSS).toContain(`@keyframes ${name}`);
    }
  });

  it("holds the wings open for about half of each beat", () => {
    // A butterfly beats and glides. An evenly-eased fold spends most of its
    // time half-closed, which at 128px reads as a flickering sliver rather
    // than wings — so the open pose has to be the one it is usually caught in.
    expect(CSS).toMatch(/@keyframes bfl-flap \{\s*0%,\s*8% \{\s*transform: scaleX\(1\);/);
    expect(CSS).toMatch(/52%,\s*100% \{\s*transform: scaleX\(1\);/);
  });

  it("stops all travel under prefers-reduced-motion but keeps the mark", () => {
    const block = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation: none");
    // Frozen at each butterfly's 0% pose, so nothing collapses onto the origin.
    expect(block).toContain("transform: translate(48px, 46px) rotate(-12deg) scale(0.36)");
    expect(block).toContain("transform: translate(76px, 66px) rotate(10deg) scale(0.29)");
    expect(block).toContain("transform: translate(58px, 86px) rotate(-4deg) scale(0.43)");
  });

  it("gives the cream page its own bloom value", () => {
    // The dark-theme alpha reads as a pink smudge over the line drawing.
    expect(CSS).toContain('[data-theme="light"] .bfl');
  });

  it("draws the torso even on a page that never declared --text-faint", () => {
    // Regression: verification.html carries hand-inlined theme tokens and was
    // missing that one. An unresolvable var() on `stroke` is not a wrong colour
    // — it is NO stroke, so the belly silently vanished and left three
    // butterflies floating on an empty screen. A mark shared by seven surfaces
    // must not depend on a token any one page can forget.
    expect(CSS).toContain("--bfl-line: var(--text-faint, #6a656b)");
    expect(CSS).toContain("--bfl-line: var(--text-faint, #9a949c)");
    expect(CSS).not.toMatch(/stroke:\s*var\(--text-faint\)/);
  });
});

describe("verification.html pre-paint shell", () => {
  // The shell paints before the bundle exists, and verification.ts renders the
  // same mark for its own `loading` screen. If the two drift, the handover
  // becomes a visible swap on the one screen a user is already nervous on.
  it("inlines byte-identical markup to the module's", () => {
    expect(VERIFICATION_HTML).toContain(butterflyLoaderMarkup());
  });

  it("inlines every keyframe the shared stylesheet defines", () => {
    const names = [...CSS.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(VERIFICATION_HTML, `verification.html is missing @keyframes ${name}`).toContain(
        `@keyframes ${name}`,
      );
    }
  });

  it("inlines the custom properties the mark's colours resolve through", () => {
    for (const prop of ["--bfl-glow", "--bfl-line"]) {
      expect(CSS).toContain(prop);
      expect(VERIFICATION_HTML, `verification.html is missing ${prop}`).toContain(prop);
    }
  });

  it("no longer ships the ring spinner it replaced", () => {
    expect(VERIFICATION_HTML).not.toContain('class="spinner"');
  });
});
