import { describe, expect, it, vi } from "vitest";
import { keepOpenOnVerticalSwipe } from "./telegram-swipes.js";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck`. theme.css comes through as text
// only because vite.config.ts lists it in `test.css.include`.
import THEME_CSS from "./theme.css?raw";

/**
 * Swipe-to-close is off on every Mini App page (decision 2026-09-29): scrolling
 * back up from the top of a screen used to drag the whole sheet down.
 */

const HTML_ENTRIES = import.meta.glob<string>("../*.html", {
  query: "?raw",
  import: "default",
  eager: true,
});

const SOURCES = import.meta.glob<string>(
  ["./*.ts", "./*.tsx", "./*/*.ts", "./*/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx", "!./**/*.d.ts"],
  { query: "?raw", import: "default", eager: true },
);

describe("keepOpenOnVerticalSwipe", () => {
  it("disables vertical swipes exactly once", () => {
    const disableVerticalSwipes = vi.fn();
    keepOpenOnVerticalSwipe({ disableVerticalSwipes });
    expect(disableVerticalSwipes).toHaveBeenCalledTimes(1);
  });

  it("is a no-op outside Telegram", () => {
    expect(() => keepOpenOnVerticalSwipe(undefined)).not.toThrow();
    expect(() => keepOpenOnVerticalSwipe(null)).not.toThrow();
  });

  it("leaves an older client (< Bot API 7.7) alone", () => {
    expect(() => keepOpenOnVerticalSwipe({})).not.toThrow();
  });

  it("never lets a throwing client break boot", () => {
    const disableVerticalSwipes = vi.fn(() => {
      throw new Error("WebAppMethodUnsupported");
    });
    expect(() => keepOpenOnVerticalSwipe({ disableVerticalSwipes })).not.toThrow();
    expect(disableVerticalSwipes).toHaveBeenCalledTimes(1);
  });
});

describe("every Mini App entry keeps the sheet open", () => {
  const entries = Object.entries(HTML_ENTRIES).map(([path, html]) => {
    const m = /<script[^>]*type="module"[^>]*src="\/src\/([^"]+)"/.exec(html);
    return { path, html, module: m ? `./${m[1]}` : null };
  });

  it("finds all thirteen HTML entries and their modules", () => {
    expect(entries).toHaveLength(13);
    for (const e of entries) {
      expect(e.module, `${e.path} has no /src module script`).not.toBeNull();
      expect(SOURCES[e.module!], `${e.module} (from ${e.path}) not found`).toBeTypeOf("string");
    }
  });

  it.each(entries.map((e) => [e.path, e.module] as const))(
    "%s → %s calls keepOpenOnVerticalSwipe",
    (_path, module) => {
      const src = SOURCES[module!]!;
      expect(src).toMatch(/import \{ keepOpenOnVerticalSwipe \} from "\.\.?\/telegram-swipes\.js";/);
      expect(src).toMatch(/keepOpenOnVerticalSwipe\((app|tg)\);/);
    },
  );

  it("nothing turns swipe-to-close back on", () => {
    for (const [path, src] of Object.entries(SOURCES)) {
      expect(src, path).not.toMatch(/enableVerticalSwipes\s*\?*\.?\s*\(/);
    }
  });
});

describe("no rubber-band on pages that scroll as a whole", () => {
  it("theme.css turns root overscroll off", () => {
    expect(THEME_CSS).toMatch(/html,\s*body\s*\{\s*overscroll-behavior-y:\s*none;\s*\}/);
  });

  it.each(["../index.html", "../verification.html"])(
    "%s (no theme.css) inlines the same rule",
    (path) => {
      const html = HTML_ENTRIES[path];
      expect(html).toBeTypeOf("string");
      expect(html).toMatch(/html,\s*body\s*\{[^}]*overscroll-behavior-y:\s*none;[^}]*\}/);
    },
  );
});
