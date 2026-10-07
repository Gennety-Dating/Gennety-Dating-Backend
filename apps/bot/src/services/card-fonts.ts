import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type satori from "satori";

/**
 * The font list of the date card (2026-10-07).
 *
 * Its display type is the brand face, Gennety Display. That is Geologica with
 * the sharpness axis pinned at 50, byte-identical to the iOS
 * `GennetyDisplay-*` files and to the Mini App's woff2 subset of them (founder
 * decision 2026-10-01). Body text stays Roboto, the same role the system face
 * plays in the apps.
 *
 * Only the date card uses this list. It replaces the card's Archivo Black,
 * which has no Cyrillic at all. That is how the copy audit of 2026-10-01
 * silently changed the card: the slogan became Russian and satori drew it in
 * thin Roboto. The OTHER cards keep their own faces (Archivo Black, Unbounded)
 * by the founder's call of 2026-10-07: they "look good in Telegram".
 *
 * Archivo Black stays in this list for one word: "Gennety" in the card's
 * header, typed in its original face (founder, 2026-10-07). It has no
 * Cyrillic, so `template.test.ts` checks that nothing else is set in it.
 *
 * Coverage: all five product languages (ru, uk, en, de, pl, including
 * ʼ ’ « » —) are in the files, checked by `card-fonts.test.ts`.
 *
 * Only the weights the card sets exist here: 800 for the slogan and 700 for
 * the venue name. Ask for one of them explicitly (`fontWeight`). Satori
 * resolves an unregistered weight to the nearest one, which reads as a silent
 * substitution in review.
 */

export const DISPLAY_FAMILY = "Gennety Display";
export const BODY_FAMILY = "Roboto";
/** The header word "Gennety" only. Latin-only face, single heavy weight. */
export const LOGO_FAMILY = "Archivo Black";

export type SatoriFonts = Parameters<typeof satori>[1]["fonts"];

let cached: SatoriFonts | null = null;

function read(file: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url)));
}

export function cardFonts(): SatoriFonts {
  if (cached) return cached;
  cached = [
    { name: BODY_FAMILY, data: read("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: BODY_FAMILY, data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: BODY_FAMILY, data: read("Roboto-Bold.ttf"), weight: 700, style: "normal" },
    { name: DISPLAY_FAMILY, data: read("GennetyDisplay-Bold.ttf"), weight: 700, style: "normal" },
    { name: DISPLAY_FAMILY, data: read("GennetyDisplay-ExtraBold.ttf"), weight: 800, style: "normal" },
    { name: LOGO_FAMILY, data: read("ArchivoBlack-Regular.ttf"), weight: 400, style: "normal" },
  ];
  return cached;
}
