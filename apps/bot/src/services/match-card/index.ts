/**
 * Match-card renderer — the collage "pitch card" a user receives when the
 * engine proposes a partner (replaces the plain photo media-group as the
 * leading visual; PRODUCT_SPEC match pitch). Shares the satori→resvg pipeline
 * with the date-card service, but composes the photographic collage upstream
 * in canvas (collage.ts) because satori cannot tear paper.
 *
 * Like renderDateCard, this never throws: any failure returns `null` so the
 * caller falls back to the classic photo media-group — a match proposal must
 * never be blocked by cosmetics.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { grainPng, toPngBuffer } from "../date-card/image.js";
import { buildCollageLayer, butterflyPng, CARD_W, CARD_H } from "./collage.js";
import {
  buildMatchCardElement,
  collageSpecFor,
  GRAPHITE,
  type MatchCardTexts,
  type MatchCardVariant,
} from "./template.js";

export type { MatchCardTexts, MatchCardVariant };
export { MATCH_CARD_VARIANTS } from "./template.js";

export interface MatchCardInput {
  /** Partner profile photos, raw bytes in profile order (1–4 used). */
  photos: Buffer[];
  texts: MatchCardTexts;
  /** Seeds tear jitter etc. Use the match id so retries and the A/B copies match. */
  seed: string;
  variant: MatchCardVariant;
}

type SatoriFonts = Parameters<typeof satori>[1]["fonts"];
let cachedFonts: SatoriFonts | null = null;

function loadFonts(): SatoriFonts {
  if (cachedFonts) return cachedFonts;
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)));
  cachedFonts = [
    { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: "Roboto", data: read("Roboto-Bold.ttf"), weight: 700, style: "normal" },
    // Unbounded ships as cyrillic+latin subset woffs; registering both under
    // one family lets satori fall through per glyph.
    { name: "Unbounded", data: read("unbounded-cyr-700.woff"), weight: 700, style: "normal" },
    { name: "Unbounded", data: read("unbounded-lat-700.woff"), weight: 700, style: "normal" },
  ];
  return cachedFonts;
}

/** Full-card film-grain tile, generated once and reused for every render. */
let cachedGrain: Buffer | null = null;
function grainTile(): Buffer {
  if (!cachedGrain) cachedGrain = grainPng(CARD_W, CARD_H, 8);
  return cachedGrain;
}

const headerButterflyCache = new Map<string, Buffer | null>();
async function headerButterfly(variant: MatchCardVariant): Promise<Buffer | null> {
  // Dark variants carry a soft-white mark; paper keeps the brand gradient.
  const tint = variant === "paper" ? undefined : "#F5F5F5";
  const key = tint ?? "brand";
  if (!headerButterflyCache.has(key)) {
    headerButterflyCache.set(key, await butterflyPng(108, tint));
  }
  return headerButterflyCache.get(key) ?? null;
}

export async function renderMatchCard(input: MatchCardInput): Promise<Buffer | null> {
  try {
    // Normalize photos to real PNG bytes (Telegram serves JPEG) and drop any
    // that fail to decode instead of aborting the whole card.
    const photos = (await Promise.all(input.photos.map((p) => toPngBuffer(p)))).filter(
      (p): p is Buffer => p !== null,
    );
    if (photos.length === 0) return null;

    const collage = await buildCollageLayer(photos, collageSpecFor(input.variant), input.seed);
    const element = buildMatchCardElement(input.variant, input.texts, {
      collage,
      grain: grainTile(),
      butterfly: await headerButterfly(input.variant),
    });

    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: CARD_W,
      height: CARD_H,
      fonts: loadFonts(),
    });
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: CARD_W },
      background: GRAPHITE,
    })
      .render()
      .asPng();
    return Buffer.from(png);
  } catch (err) {
    console.warn("[match-card] render failed:", err);
    return null;
  }
}
