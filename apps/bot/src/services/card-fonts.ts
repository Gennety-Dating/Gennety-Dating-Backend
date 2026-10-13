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
 * The header word "Gennety" is set in Gennety Display too (founder, 2026-10-07),
 * so Archivo Black is not in this list at all.
 *
 * Coverage: all five product languages (ru, uk, en, de, pl, including
 * ʼ ’ « » —) are in the files, checked by `card-fonts.test.ts`.
 *
 * Only the weights the card sets exist here: 800 for the slogan and the header
 * word, 700 for the venue name. Ask for one of them explicitly (`fontWeight`). Satori
 * resolves an unregistered weight to the nearest one, which reads as a silent
 * substitution in review.
 */

export const DISPLAY_FAMILY = "Gennety Display";
export const BODY_FAMILY = "Roboto";

export type SatoriFonts = Parameters<typeof satori>[1]["fonts"];

let cached: SatoriFonts | null = null;

/** Bundled font files already read, by file name under `assets/fonts/`. */
const fontFiles = new Map<string, Buffer>();

/**
 * The bytes of one bundled font file (`assets/fonts/<file>`), read once per
 * process and handed to every card's font list.
 *
 * Each card module used to read its own copy of the same files — Roboto
 * Regular and Medium seven times each, Bold four, ~0.5 MB a copy — and satori
 * caches a parsed font by the identity of its `data` buffer, so every copy was
 * also parsed and held again. One buffer per file means one read and one parse
 * per process; the bytes, and so every rendered card, are the same.
 */
export function fontFile(file: string): Buffer {
  const known = fontFiles.get(file);
  if (known) return known;
  const data = readFileSync(fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url)));
  fontFiles.set(file, data);
  return data;
}

export function cardFonts(): SatoriFonts {
  if (cached) return cached;
  cached = [
    { name: BODY_FAMILY, data: fontFile("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: BODY_FAMILY, data: fontFile("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: BODY_FAMILY, data: fontFile("Roboto-Bold.ttf"), weight: 700, style: "normal" },
    { name: DISPLAY_FAMILY, data: fontFile("GennetyDisplay-Bold.ttf"), weight: 700, style: "normal" },
    { name: DISPLAY_FAMILY, data: fontFile("GennetyDisplay-ExtraBold.ttf"), weight: 800, style: "normal" },
  ];
  return cached;
}
