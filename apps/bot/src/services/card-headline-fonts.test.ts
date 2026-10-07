import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

import { cardFonts, DISPLAY_FAMILY, BODY_FAMILY, type SatoriFonts } from "./card-fonts.js";

/**
 * Display-type coverage for every rendered card (they all share `cardFonts()`).
 *
 * Satori never reports a missing glyph. It silently resolves it from another
 * registered family, so a display face that doesn't cover the user's script
 * renders in Roboto and nothing anywhere fails. That silence is how the copy
 * audit of 2026-10-01 changed the date card without anyone noticing: its
 * slogan became Russian, the card's Archivo Black had no Cyrillic, and the
 * headline came out in thin Roboto. Before that the Unbounded subsets had done
 * the same to Latin ("Gennety" itself) and to Polish ("WRZEŚNIA").
 *
 * Coverage is proven by differential render: the same string drawn with the
 * real font list versus the body font alone. If the display face carries the
 * glyphs the rasters differ; if not, both fall through to Roboto and come out
 * byte-identical. The last case below proves the method can see a gap.
 */

const bodyOnly = (fonts: SatoriFonts): SatoriFonts => fonts.filter((f) => f.name === BODY_FAMILY);

async function rasterize(text: string, family: string, weight: number, fonts: SatoriFonts): Promise<Buffer> {
  const svg = await satori(
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          width: "760px",
          height: "150px",
          fontFamily: family,
          fontWeight: weight,
          fontSize: "60px",
          color: "#FFFFFF",
          backgroundColor: "#000000",
        },
        children: text,
      },
    } as unknown as Parameters<typeof satori>[0],
    { width: 760, height: 150, fonts },
  );
  return Buffer.from(new Resvg(svg).render().asPng());
}

/** What the five locales actually put on a card. */
const SCRIPTS: ReadonlyArray<[string, string]> = [
  ["latin (en, and the typed fallback wordmark)", "Gennety WRZESNIA"],
  ["latin-ext (pl)", "ŁĄŻŚĆŹŃĘ"],
  ["german", "ÄÖÜß"],
  ["cyrillic (ru + uk-only letters)", "ВЫШЛОЇЄҐІ"],
  ["uk apostrophe + punctuation", "Здоровʼя — «так»."],
  ["digits (time card)", "19:30 09.10"],
];

const WEIGHTS = [600, 700, 800] as const;

describe("card display font coverage", () => {
  for (const weight of WEIGHTS) {
    for (const [scriptName, sample] of SCRIPTS) {
      it(`Gennety Display ${weight} draws ${scriptName}, not Roboto`, async () => {
        const fonts = cardFonts();
        const [withDisplay, control] = await Promise.all([
          rasterize(sample, DISPLAY_FAMILY, weight, fonts),
          rasterize(sample, BODY_FAMILY, weight, bodyOnly(fonts)),
        ]);
        expect(withDisplay.equals(control)).toBe(false);
      }, 60_000);
    }
  }

  it("proves the differential detects a gap", async () => {
    // Ɓ Ɔ Ɗ (Latin Extended-B) are in Roboto but not in Gennety Display, so
    // they must fall through and come out identical to the body-only render.
    // Without this the cases above could pass for the wrong reason. (The
    // sample must exist in Roboto: a glyph missing from both draws each
    // face's own .notdef box, and those differ.)
    const fonts = cardFonts();
    const [withDisplay, control] = await Promise.all([
      rasterize("ƁƆƊ", DISPLAY_FAMILY, 800, fonts),
      rasterize("ƁƆƊ", BODY_FAMILY, 800, bodyOnly(fonts)),
    ]);
    expect(withDisplay.equals(control)).toBe(true);
  }, 60_000);

  it("registers one file per display weight, and only the brand weights", () => {
    const display = cardFonts().filter((f) => f.name === DISPLAY_FAMILY);
    expect(display.map((f) => f.weight).sort()).toEqual([600, 700, 800]);
  });
});

/**
 * Every renderer must take its display type from `card-fonts.ts`. A card that
 * registered its own face again (Archivo Black, Unbounded, a subset under a
 * private family name) is exactly how the cards drifted apart before.
 */
describe("card renderers use the shared brand face", () => {
  const RENDERERS = [
    "date-card/template.ts",
    "date-card/compose.ts",
    "coordination-card/template.ts",
    "coordination-card/index.ts",
    "referral-card/index.ts",
    "match-card/template.ts",
    "match-card/index.ts",
    "rematch-card.ts",
    "expiry-card.ts",
    "time-card.ts",
  ];
  const source = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), "utf8");

  it.each(RENDERERS)("%s names no private display family", (rel) => {
    const code = source(rel);
    expect(code).not.toMatch(/fontFamily:\s*"(Archivo Black|Unbounded|Headline Cyr)"/);
    expect(code).not.toMatch(/name:\s*"(Archivo Black|Unbounded|Headline Cyr)"/);
  });
});
