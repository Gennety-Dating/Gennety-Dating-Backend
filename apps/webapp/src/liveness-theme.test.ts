import { describe, expect, it } from "vitest";
// Vite's `?raw` rather than `node:fs`: this package compiles with `types: []`
// (browser-only), so a Node builtin import would break `pnpm typecheck` even
// though vitest would happily run it.
import CSS from "./liveness-theme.css?raw";
import ISLAND_SOURCE from "./liveness-detector.tsx?raw";

/**
 * Guards on the Face Liveness brand theme.
 *
 * Restyling a biometric check is not ordinary CSS work. Some of what the
 * detector draws is not decoration but the signal itself — the light challenge
 * flashes a server-issued colour sequence, and the oval's geometry, mirroring
 * and white surround are what make a capture verifiable. A well-meaning
 * "let's make the oval burgundy too" is a compliance regression that no type
 * checker and no screenshot diff would flag.
 *
 * So the boundary is written down as an executable rule: the theme may repaint
 * chrome, and may not reach into the capture surface.
 */

/**
 * Everything here is owned by AWS's capture path. The comment block at the top
 * of the stylesheet explains each one; this is the enforcement.
 */
const FORBIDDEN_SELECTORS = [
  // The light challenge. Its colours ARE the liveness signal.
  ".amplify-liveness-freshness-canvas",
  // Oval geometry + the `#fff` mask AWS paints around it to light the face.
  ".amplify-liveness-oval-canvas",
  // `transform: scaleX(-1)` — the preview mirroring the user positions against.
  ".amplify-liveness-video",
  // Distance feedback: its width and transition are the "keep moving closer"
  // signal, not a progress bar we may restyle.
  ".amplify-liveness-match-indicator",
  // Must stay unmistakable over an arbitrary camera feed.
  ".amplify-liveness-recording-icon",
] as const;

/**
 * The oval's stroke colour is read out of the cascade by
 * `getComputedStyle(canvas).getPropertyValue(...)`, so overriding this token
 * repaints the oval just as surely as touching its canvas rule would.
 */
const FORBIDDEN_TOKENS = ["--amplify-colors-border-secondary"] as const;

/**
 * Tokens the detector reads back through `getComputedStyle` and hands to a
 * canvas `fillStyle`. An unresolved `var(...)` there does not throw — it fails
 * silently to transparent, leaving the start screen showing raw camera behind
 * what should be an opaque backdrop. So these must be declared as literal
 * colours, never as `var()` indirection.
 */
const CANVAS_READBACK_TOKENS = ["--amplify-colors-background-primary"] as const;

/** Every `--token: value;` declaration in the file, in source order. */
function declarations(): { token: string; value: string }[] {
  return [...CSS.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)].map((m) => ({
    token: m[1]!,
    value: m[2]!.trim(),
  }));
}

/** Declarations inside the block introduced by `selector`, up to its `}`. */
function blockFor(selector: string): string {
  const start = CSS.indexOf(selector);
  expect(start, `${selector} block is missing`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

function tokensIn(selector: string): Set<string> {
  return new Set(
    [...blockFor(selector).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]!),
  );
}

describe("liveness brand theme", () => {
  describe("compliance boundary", () => {
    it.each(FORBIDDEN_SELECTORS)("never styles %s", (selector) => {
      // Comments explain why each is off-limits, so strip them before matching
      // — the mention in the header block is documentation, not a rule.
      const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(withoutComments).not.toContain(selector);
    });

    it.each(FORBIDDEN_TOKENS)("never overrides %s", (token) => {
      const overridden = declarations().some((d) => d.token === token);
      expect(overridden).toBe(false);
    });

    it("never overrides an animation duration or timing", () => {
      const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(withoutComments).not.toMatch(/animation(-duration|-delay)?\s*:/i);
      expect(withoutComments).not.toMatch(/transition\s*:/i);
    });
  });

  describe("canvas-read tokens", () => {
    it.each(CANVAS_READBACK_TOKENS)(
      "%s is a literal colour, not a var() chain",
      (token) => {
        const values = declarations()
          .filter((d) => d.token === token)
          .map((d) => d.value);

        expect(values.length, `${token} is never declared`).toBeGreaterThan(0);
        for (const value of values) {
          expect(value, `${token} must not resolve through var()`).not.toContain(
            "var(",
          );
          expect(value).toMatch(/^#[0-9a-f]{3,8}$/i);
        }
      },
    );
  });

  describe("theme parity", () => {
    it("defines the same token set in both themes", () => {
      // A token present in only one theme is the classic half-themed bug: the
      // other theme silently inherits Amplify's teal/white default.
      const dark = tokensIn(':root[data-theme="dark"]');
      const light = tokensIn(':root[data-theme="light"]');
      expect([...light].sort()).toEqual([...dark].sort());
    });

    it("gives both themes a full burgundy primary ramp", () => {
      // Amplify keys buttons off 80, hover/focus off 90/100, and derives
      // `--amplify-colors-font-focus` from 100. A partial ramp leaks teal into
      // whichever state was left out.
      for (const selector of [
        ':root[data-theme="dark"]',
        ':root[data-theme="light"]',
      ]) {
        const tokens = tokensIn(selector);
        for (const step of [10, 20, 40, 60, 80, 90, 100]) {
          expect(
            tokens.has(`--amplify-colors-primary-${step}`),
            `${selector} is missing primary-${step}`,
          ).toBe(true);
        }
      }
    });

    it("loads after Amplify's own stylesheet", () => {
      // Several overrides tie on specificity with Amplify's base rules, so
      // source order decides. Vite emits CSS in import order.
      const amplify = ISLAND_SOURCE.indexOf('"@aws-amplify/ui-react/styles.css"');
      const brand = ISLAND_SOURCE.indexOf('"./liveness-theme.css"');
      expect(amplify).toBeGreaterThan(-1);
      expect(brand).toBeGreaterThan(amplify);
    });
  });
});
