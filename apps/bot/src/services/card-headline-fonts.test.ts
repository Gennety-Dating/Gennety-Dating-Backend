import { describe, it, expect } from "vitest";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

import { loadFonts as timeCardFonts } from "./time-card.js";
import { loadFonts as matchCardFonts } from "./match-card/index.js";
import { loadFonts as rematchCardFonts } from "./rematch-card.js";

/**
 * Headline-font coverage for the PNG cards that render localized display type.
 *
 * Satori never reports a missing glyph. It silently resolves it from another
 * registered family, so a headline face that doesn't cover the user's script
 * renders in Roboto mid-word and nothing anywhere fails. Two real regressions
 * came out of exactly that silence:
 *
 *   - The match card registered Unbounded's `cyrillic` and `latin` subset woffs
 *     BOTH under the family name "Unbounded", believing satori would fall
 *     through per glyph. It does not — fallback crosses FAMILIES in
 *     registration order, never within one. Cyrillic was listed first, so it
 *     owned the family and every Latin glyph (including the "Gennety" wordmark
 *     on every card) dropped to Roboto.
 *   - The time card sidestepped that correctly, but both subsets together still
 *     miss `latin-ext`, so Polish dates ("WRZEŚNIA", "PAŹDZIERNIKA") rendered
 *     ĄŁŚŹ in Roboto.
 *
 * Both now load the full `unbounded-700.woff` under one name. There is no font
 * parser here (not worth a dependency), so coverage is proven the same way
 * `expiry-card.test.ts` proves it: differential render. Draw the same string
 * with the card's REAL font array versus Roboto alone — if the headline face
 * carries the glyphs the rasters differ; if it doesn't, both fall through to
 * Roboto and come out byte-identical.
 *
 * Using each module's actual `loadFonts()` is the point: a test that
 * re-declared the font list would keep passing while the renderer regressed.
 */

type SatoriFonts = Parameters<typeof satori>[1]["fonts"];

/**
 * The control must be the card's OWN body font at the OWN weight — not a
 * hand-rolled Roboto list. The match card registers Roboto at 400/500/700; a
 * fixed Roboto-Medium-500 control would differ from a failed render simply
 * because the fallback landed on Roboto Bold 700, and the assertion would pass
 * while the headline face contributed nothing. Deriving the control from the
 * same array leaves exactly one variable: whether the display family resolved.
 */
const bodyOnly = (fonts: SatoriFonts): SatoriFonts =>
  fonts.filter((f) => f.name === "Roboto");

async function rasterize(
  text: string,
  family: string,
  fonts: SatoriFonts,
): Promise<Buffer> {
  const svg = await satori(
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          width: "700px",
          height: "150px",
          fontFamily: family,
          fontWeight: 700,
          fontSize: "60px",
          color: "#FFFFFF",
          backgroundColor: "#000000",
        },
        children: text,
      },
    } as unknown as Parameters<typeof satori>[0],
    { width: 700, height: 150, fonts },
  );
  return Buffer.from(new Resvg(svg).render().asPng());
}

/**
 * The three scripts the five supported locales actually produce:
 *   latin      — en (and the "Gennety" wordmark, in every locale)
 *   latinExt   — pl
 *   cyrillic   — ru + the uk-only letters
 * German's ÄÖÜß is Latin-1 and inside every `latin` subset, so it needs no case.
 */
const SCRIPTS: ReadonlyArray<[string, string]> = [
  ["latin", "WRZESNIA"],
  ["latin-ext (Polish)", "ŁĄŻŚĆŹŃĘ"],
  ["cyrillic", "ВЫШЛОЇЄҐІ"],
];

const CARDS: ReadonlyArray<[string, string, () => SatoriFonts]> = [
  // Family name is the one each renderer actually asks for in its styles.
  ["time-card", "Unbounded", timeCardFonts],
  ["match-card", "Unbounded", matchCardFonts],
  ["rematch-card", "Unbounded", rematchCardFonts],
];

describe("card headline font coverage", () => {
  for (const [cardName, family, fonts] of CARDS) {
    for (const [scriptName, sample] of SCRIPTS) {
      it(
        `${cardName} renders ${scriptName} in the headline face, not Roboto`,
        async () => {
          const registered = fonts();
          const [withHeadlineFace, control] = await Promise.all([
            rasterize(sample, family, registered),
            rasterize(sample, "Roboto", bodyOnly(registered)),
          ]);
          // Identical rasters mean every glyph fell through to the body font —
          // i.e. the headline face contributed nothing for this script.
          expect(withHeadlineFace.equals(control)).toBe(false);
        },
        60_000,
      );
    }
  }

  it("registers each headline family name exactly once", () => {
    // The match-card regression was a duplicate family name, not a missing
    // file: two fonts under "Unbounded" meant the first one silently won for
    // every glyph. Guarding the shape catches a reintroduction even if the
    // subset files happen to cover the sampled strings above.
    for (const [cardName, , fonts] of CARDS) {
      const names = fonts().map((f) => f.name);
      const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
      const unique = [...new Set(duplicated)];
      // Roboto legitimately repeats across weights; a display face must not.
      expect(
        unique.filter((n) => n !== "Roboto"),
        `${cardName} registers a non-Roboto family more than once: ${unique.join(", ")}`,
      ).toEqual([]);
    }
  });
});
