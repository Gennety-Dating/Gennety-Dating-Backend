import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck`. The stylesheets come through as
// text only because vite.config.ts lists them in `test.css.include`.
import FONTS_CSS from "./fonts.css?raw";
import TICKET_CSS from "./ticket/ticket.css?raw";
import TERMINAL_CSS from "./date-terminal/terminal.css?raw";
import STORE_CSS from "./tickets/store.css?raw";
import RADAR_CSS from "./radar/radar.css?raw";
import VENUE_CHANGE_CSS from "./venue-change.css?raw";
import TERMINAL_MAIN from "./date-terminal/main.tsx?raw";
import TICKETS_MAIN from "./tickets/main.tsx?raw";

/**
 * Display type in the Mini App is Gennety Display (fonts.css), the iOS app's
 * own face. It replaced Google Fonts' Space Grotesk, which has no Cyrillic —
 * every ru/uk heading rendered in two faces at once (decision 2026-10-01).
 */

const HTML_ENTRIES = import.meta.glob<string>("../*.html", {
  query: "?raw",
  import: "default",
  eager: true,
});

const FONT_FILES = import.meta.glob<string>("./fonts/*.woff2", {
  query: "?url",
  import: "default",
  eager: true,
});

/** CSS comments stripped: the prose explains what a rule used to be. */
const code = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const PAGE_CSS: Record<string, string> = {
  "ticket/ticket.css": TICKET_CSS,
  "date-terminal/terminal.css": TERMINAL_CSS,
  "tickets/store.css": STORE_CSS,
  "radar/radar.css": RADAR_CSS,
  "venue-change.css": VENUE_CHANGE_CSS,
};

describe("Gennety Display in the Mini App", () => {
  it("is self-hosted in the three weights the type scale uses", () => {
    const css = code(FONTS_CSS);
    const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
    expect(faces).toHaveLength(3);
    const weights = faces.map((face) => /font-weight:\s*(\d+)/.exec(face)?.[1]).sort();
    expect(weights).toEqual(["600", "700", "800"]);
    for (const face of faces) {
      expect(face).toContain('font-family: "Gennety Display"');
      expect(face).toMatch(/font-style:\s*normal/);
      expect(face).toMatch(/font-display:\s*swap/);
      // Module-relative, so Vite fingerprints it: Caddy serves *.woff2 as
      // immutable for a year, and a fixed name would pin the old subset.
      const url = /url\("\.\/(fonts\/[^"]+\.woff2)"\)/.exec(face);
      expect(url, `module-relative woff2 url in ${face}`).not.toBeNull();
      expect(Object.keys(FONT_FILES)).toContain(`./${url![1]}`);
    }
    expect(css).toMatch(/--font-display:\s*"Gennety Display",/);
  });

  it("is what every display rule asks for — no Space Grotesk left", () => {
    for (const [name, css] of Object.entries(PAGE_CSS)) {
      expect(code(css), name).not.toMatch(/Space Grotesk/);
      expect(code(css), name).toContain("var(--font-display)");
    }
  });

  it("reaches every page that sets display type", () => {
    // ticket.css carries it for the ticket, tickets and date-terminal pages;
    // the last two import ticket.css ahead of their own sheet.
    expect(code(TICKET_CSS)).toContain('@import "../fonts.css";');
    expect(code(RADAR_CSS)).toContain('@import "../fonts.css";');
    expect(code(VENUE_CHANGE_CSS)).toContain('@import "./fonts.css";');
    expect(TERMINAL_MAIN).toContain('import "../ticket/ticket.css";');
    expect(TICKETS_MAIN).toContain('import "../ticket/ticket.css";');
  });

  it("is no longer requested from Google by any shell", () => {
    const shells = Object.entries(HTML_ENTRIES);
    expect(shells.length).toBeGreaterThan(10);
    for (const [name, html] of shells) {
      expect(html, name).not.toMatch(/Space\+Grotesk/);
    }
  });
});
