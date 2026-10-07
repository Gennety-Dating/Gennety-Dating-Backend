import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type satori from "satori";

/**
 * The one font list every rendered card hands to satori (2026-10-07).
 *
 * Display type on the cards is the brand face — Gennety Display, i.e.
 * Geologica with the sharpness axis pinned at 50, byte-identical to the iOS
 * `GennetyDisplay-*` files and to the Mini App's woff2 subset of them (founder
 * decision 2026-10-01). Body text stays Roboto, the same role the system
 * face plays in the apps.
 *
 * It replaces a different font set per card — Archivo Black (no Cyrillic at
 * all), the full Unbounded, and a Cyrillic-only Unbounded subset. That mix is
 * how the copy audit of 2026-10-01 could silently change the date card: its
 * slogan became Russian, Archivo Black has no Cyrillic glyphs, and satori drew
 * the line in thin Roboto instead.
 *
 * Coverage: all five product languages (ru, uk, en, de, pl — including
 * ʼ ’ « » — № ₴ €) are in the files, checked by `card-headline-fonts.test.ts`,
 * so no display line falls through to Roboto any more.
 *
 * Only 600/700/800 exist: the brand face is never set lighter. Ask for one of
 * them explicitly (`fontWeight`) — satori resolves an unregistered weight to
 * the nearest one, which reads as a silent substitution in review.
 */

export const DISPLAY_FAMILY = "Gennety Display";
export const BODY_FAMILY = "Roboto";

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
    { name: DISPLAY_FAMILY, data: read("GennetyDisplay-SemiBold.ttf"), weight: 600, style: "normal" },
    { name: DISPLAY_FAMILY, data: read("GennetyDisplay-Bold.ttf"), weight: 700, style: "normal" },
    { name: DISPLAY_FAMILY, data: read("GennetyDisplay-ExtraBold.ttf"), weight: 800, style: "normal" },
  ];
  return cached;
}
