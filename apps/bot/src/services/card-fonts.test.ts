import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

import { cardFonts, DISPLAY_FAMILY, BODY_FAMILY, type SatoriFonts } from "./card-fonts.js";

/**
 * Display-type coverage of the date card's Gennety Display (`card-fonts.ts`).
 * The other cards' faces are covered by `card-headline-fonts.test.ts` and
 * `expiry-card.test.ts`.
 *
 * Satori never reports a missing glyph. It silently takes the glyph from
 * another registered family, so a display face that lacks the user's script
 * renders in Roboto and nothing fails. That silence is how the copy audit of
 * 2026-10-01 changed the date card unnoticed: its slogan became Russian, the
 * card's Archivo Black had no Cyrillic, and the headline came out in thin
 * Roboto.
 *
 * Coverage is proven by differential render. The same string is drawn with
 * the real font list and with the body font alone. If the display face has
 * the glyphs, the rasters differ. If it lacks them, both fall back to Roboto
 * and the rasters are byte-identical. The last case below proves the method
 * can see a gap.
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

/** What the five locales put on the date card (slogan + venue name). */
const SCRIPTS: ReadonlyArray<[string, string]> = [
  ["latin (en)", "Gennety WRZESNIA"],
  ["latin-ext (pl)", "ŁĄŻŚĆŹŃĘ"],
  ["german", "ÄÖÜß"],
  ["cyrillic (ru + uk-only letters)", "ВЫШЛОЇЄҐІ"],
  ["uk apostrophe + punctuation", "Здоровʼя — «так»."],
  ["digits (venue names)", "19:30 09.10"],
];

const WEIGHTS = [700, 800] as const;

describe("date card display font coverage", () => {
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
    // they must fall back and come out identical to the body-only render.
    // Without this check, the cases above could pass for the wrong reason.
    // The sample must exist in Roboto: a glyph missing from both fonts draws
    // each face's own .notdef box, and those boxes differ.
    const fonts = cardFonts();
    const [withDisplay, control] = await Promise.all([
      rasterize("ƁƆƊ", DISPLAY_FAMILY, 800, fonts),
      rasterize("ƁƆƊ", BODY_FAMILY, 800, bodyOnly(fonts)),
    ]);
    expect(withDisplay.equals(control)).toBe(true);
  }, 60_000);

  it("registers exactly the weights the card sets", () => {
    const display = cardFonts().filter((f) => f.name === DISPLAY_FAMILY);
    expect(display.map((f) => f.weight).sort()).toEqual([700, 800]);
  });
});

/**
 * The date card must take its display type from `card-fonts.ts`. Archivo Black
 * under the slogan is exactly the 2026-10-01 regression: a Latin-only face
 * under a Cyrillic slogan. The Latin header word is in the brand face too
 * (2026-10-07), so the card has no sanctioned use of it left.
 */
describe("date card uses the brand face", () => {
  const FILES = ["date-card/template.ts", "date-card/compose.ts"];
  const source = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), "utf8");

  it.each(FILES)("%s names no other display family", (rel) => {
    const code = source(rel);
    expect(code).not.toMatch(/fontFamily:\s*"(Archivo Black|Unbounded|Headline Cyr)"/);
    expect(code).not.toMatch(/name:\s*"(Archivo Black|Unbounded|Headline Cyr)"/);
  });
});
