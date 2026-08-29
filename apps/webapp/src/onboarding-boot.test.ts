import { describe, expect, it } from "vitest";
// Vite's `?raw` rather than `node:fs`: this package compiles with `types: []`
// (browser-only), so a Node builtin import would break `pnpm typecheck` even
// though vitest would happily run it. Same reasoning — and the same pairing of
// a shell against the module it inlines — as butterfly-loader.test.ts.
// The stylesheet only arrives non-empty because vite.config.ts lists
// `onboarding.css` in `test.css.include`; vitest stubs CSS imports by default.
import CSS from "./onboarding.css?raw";
import HTML from "../onboarding.html?raw";
import TSX from "./onboarding.tsx?raw";

/** Body of the first `selector { ... }` rule in a stylesheet, whitespace-collapsed. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close).replace(/\s+/g, " ").trim();
}

/** One declaration's value out of a collapsed rule body. */
function decl(body: string, prop: string): string {
  const m = new RegExp(`(?:^|; )${prop}: ([^;]+)`).exec(body);
  if (!m) throw new Error(`no ${prop} in "${body}"`);
  return m[1].trim();
}

/**
 * The shell's inline stylesheet, with CSS comments stripped. Stripped because
 * the prose next to a rule explains what the rule must NOT be, so a guard
 * reading the raw text answers the opposite of the question it asks — the same
 * trap `.howitworks-back`'s sheen guard hit (DECISIONS.md 2026-08-20).
 */
const shellStyle = (() => {
  const m = /<style>([\s\S]*?)<\/style>/.exec(HTML.slice(HTML.indexOf("<head>")));
  return m ? m[1].replace(/\/\*[\s\S]*?\*\//g, "") : "";
})();

describe("boot orb inlined into the shell", () => {
  // The Mini App's <body> used to be `<div id="root"></div>` and nothing else,
  // so the first frame could not exist until ~124 KB of JS had downloaded,
  // parsed and run. Measured on prod over a 4G profile: first-paint 968 ms of
  // bare background, FCP 1256 ms. That blank stretch is what reads as "the app
  // froze" after tapping Open Gennety. The shell now paints the SAME orb the
  // syncing screen draws, so the handover React makes is invisible.
  it("carries a boot orb in the body, as a sibling of the React root", () => {
    const body = HTML.slice(HTML.indexOf("<body>"));
    expect(body).toContain('id="boot-orb"');
    expect(body).toContain('id="root"');
    // A sibling rather than a child: removal is then explicit (onboarding.tsx)
    // instead of resting on how createRoot() treats a non-empty container.
    expect(body).not.toMatch(/<div id="root">\s*<div id="boot-orb"/);
  });

  it("is removed by the app once React has mounted", () => {
    expect(TSX).toContain("boot-orb");
  });

  it("styles the orb inline, so it needs no external stylesheet", () => {
    // The whole point is painting before onboarding.css is even parsed; a
    // `<link>`-dependent orb would wait for exactly what it exists to beat.
    expect(shellStyle).toContain("#boot-orb");
    expect(shellStyle).toContain("--bg");
  });

  it("draws the same orb as .loading-orb — a drifted copy is a visible swap", () => {
    const orb = rule(CSS, ".loading-orb");
    for (const prop of ["width", "height", "margin", "border-radius", "background", "box-shadow"]) {
      const value = decl(orb, prop).replace(/\s+/g, " ");
      expect(shellStyle.replace(/\s+/g, " ")).toContain(value);
    }
  });

  it("breathes on the syncing screen's animation, not the six-second intro one", () => {
    // SyncingScene renders `.loading-orb.syncing-orb`, and `.syncing-orb`
    // overrides the animation down to the breath alone. The shell is standing
    // in for THAT screen, so `orbSix` here would be a different picture.
    expect(shellStyle).toContain("orbBreath");
    expect(shellStyle).not.toContain("orbSix");
    expect(shellStyle).toContain("@keyframes orbBreath");
  });

  it("reserves the height of the heading and lead the orb is centred with", () => {
    // `.orb-wrap` centres the whole block, not the orb, and React's block is
    // orb + h1 + p. Without a spacer the orb would sit ~52px lower in the shell
    // than in the screen that replaces it, and jump on handover. 72px = the
    // h1's 36px line + 12px margin + the p's 24px line.
    expect(shellStyle).toMatch(/height:\s*72px/);
  });
});

describe("first-paint blocking in the shell", () => {
  const rawHead = HTML.slice(HTML.indexOf("<head>"), HTML.indexOf("</head>"));
  // Everything but the <noscript> fallback, whose whole job is to carry the
  // blocking form of these same links.
  const head = rawHead.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");

  it("does not let third-party font CSS block the first frame", () => {
    // Two round trips to fonts.googleapis.com stood between the tap and any
    // pixel. `display=swap` is already in these URLs, i.e. text rendering in a
    // fallback face was accepted long ago; this only widens the same window,
    // and at boot the orb carries no text to flash.
    const googleLinks = head.match(/<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/g) ?? [];
    expect(googleLinks.length).toBeGreaterThan(0);
    for (const link of googleLinks) {
      expect(link).toMatch(/media="print"/);
      expect(link).toMatch(/this\.media\s*=\s*'all'/);
    }
    // Without JS the swap never runs, so the blocking form has to survive in a
    // <noscript> — and carry the same subset, or a JS-less client silently
    // pulls the 1.1 MB font this change exists to remove.
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(rawHead);
    expect(noscript, "<noscript> fallback for the font stylesheets").not.toBeNull();
    const fallbacks = noscript![1].match(/<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/g) ?? [];
    expect(fallbacks.length).toBe(googleLinks.length);
    for (const link of fallbacks) expect(link).not.toMatch(/media="print"/);
    expect(noscript![1]).toContain("icon_names=");
  });

  it("declares no local stylesheet of its own — Vite injects those, blocking", () => {
    // Written as "there are none" rather than "the local ones are blocking",
    // because the second is vacuously true here and a guard that cannot fail
    // is worse than no guard. `onboarding.css` / `theme.css` are module
    // imports, so the production build appends three render-blocking
    // <link>s at the END of this head. They stay blocking on purpose: they
    // are same-origin and ~54 KB raw, and asyncing them would buy ~150 ms at
    // the price of a FOUC on the registration funnel. This fires the moment
    // someone hand-writes a local stylesheet into the shell instead.
    const sheets = head.match(/<link[^>]*rel="stylesheet"[^>]*>/g) ?? [];
    for (const link of sheets) expect(link).toContain("fonts.googleapis.com");
  });

  it("defers the Telegram SDK so the parser can reach the body", () => {
    // A classic script in <head> blocks parsing outright, so <body> — and the
    // orb in it — did not exist until telegram.org answered (measured
    // 279 → 675 ms). `defer` keeps execution order: deferred classic scripts
    // and modules both run in document order, and this one is written first,
    // so window.Telegram is still there when our module starts.
    const tg = /<script[^>]*telegram-web-app\.js[^>]*>/.exec(HTML);
    expect(tg, "telegram-web-app.js script tag").not.toBeNull();
    expect(tg![0]).toMatch(/\bdefer\b/);
    expect(HTML.indexOf("telegram-web-app.js")).toBeLessThan(HTML.indexOf('type="module"'));
  });
});

describe("Material Symbols subset", () => {
  // The full variable font is 1,127,204 bytes and took 3.8 s of the boot on a
  // 4G profile; onboarding.html is the ONLY one of the Mini App shells that
  // asks for it. Three glyphs are actually used, and `font-variation-settings`
  // appears nowhere, so the axes are dead weight too. Subsetted: 2,260 bytes.
  const used = new Set(
    [...TSX.matchAll(/material-symbols-outlined[^>]*>\s*([a-z_]+)\s*</g)].map((m) => m[1]),
  );

  it("asks Google for exactly the glyphs the screen renders", () => {
    const m = /icon_names=([a-z_,]+)/.exec(HTML);
    expect(m, "icon_names= on the Material Symbols URL").not.toBeNull();
    const requested = new Set(m![1].split(","));
    // Equality both ways on purpose. A glyph added to the TSX without being
    // added here renders as its own NAME in a fallback face — the failure is
    // silent, and this is the only thing that catches it.
    expect([...requested].sort()).toEqual([...used].sort());
  });

  it("still finds the glyphs it is meant to be guarding", () => {
    // Guards the regex above: if a refactor changes how the spans are written,
    // `used` silently empties and the assertion above passes on two empty sets.
    expect(used.size).toBeGreaterThanOrEqual(3);
    expect(used).toContain("arrow_back");
  });
});
