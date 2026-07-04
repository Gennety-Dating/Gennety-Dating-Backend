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
import { buildCollageLayer, butterflyPng, CARD_W, CARD_H, type ButterflyMark } from "./collage.js";
import {
  buildMatchCardElement,
  collageSpecFor,
  paperDuoCard,
  paperDuoSpec,
  paperSoloCard,
  paperSoloSpec,
  GRAPHITE,
  type CardNode,
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

const headerButterflyCache = new Map<string, ButterflyMark | null>();
async function headerButterfly(variant: MatchCardVariant): Promise<ButterflyMark | null> {
  // Dark variants carry a soft-white mark; paper keeps the brand gradient.
  const tint = variant === "paper" ? undefined : "#F5F5F5";
  const key = tint ?? "brand";
  if (!headerButterflyCache.has(key)) {
    headerButterflyCache.set(key, await butterflyPng(160, tint));
  }
  return headerButterflyCache.get(key) ?? null;
}

async function rasterize(element: CardNode): Promise<Buffer> {
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
    return await rasterize(element);
  } catch (err) {
    console.warn("[match-card] render failed:", err);
    return null;
  }
}

/**
 * The paper design as a card SET: TWO tilted near-native-aspect photos per
 * card (no harsh crops). Text placement follows the photo count:
 *   - odd count  → the final card holds the leftover single photo AND the
 *     text panel (it has the room; the other cards stay clean);
 *   - even count → the first card carries the panel alongside its two photos.
 * The panel never covers a person — layouts keep faces clear of it.
 *
 * Returns `null` (never throws) when nothing could be rendered, so callers
 * fall back to the plain photo media-group.
 */
export async function renderMatchCardSet(
  input: Omit<MatchCardInput, "variant">,
): Promise<Buffer[] | null> {
  try {
    const photos = (await Promise.all(input.photos.map((p) => toPngBuffer(p)))).filter(
      (p): p is Buffer => p !== null,
    );
    if (photos.length === 0) return null;

    const chunks: Buffer[][] = [];
    for (let i = 0; i < photos.length; i += 2) chunks.push(photos.slice(i, i + 2));
    const lastIsSolo = chunks[chunks.length - 1]!.length === 1;
    const textCardIndex = lastIsSolo ? chunks.length - 1 : 0;

    const butterfly = await headerButterfly("paper");
    const grain = grainTile();
    const cards: Buffer[] = [];
    for (const [i, chunk] of chunks.entries()) {
      const withPanel = i === textCardIndex;
      const spec = chunk.length === 1 ? paperSoloSpec() : paperDuoSpec(withPanel);
      const collage = await buildCollageLayer(chunk, spec, `${input.seed}#${i}`);
      const layers = { collage, grain, butterfly };
      const element =
        chunk.length === 1
          ? paperSoloCard(input.texts, layers)
          : paperDuoCard(input.texts, layers, withPanel);
      cards.push(await rasterize(element));
    }
    return cards;
  } catch (err) {
    console.warn("[match-card] set render failed:", err);
    return null;
  }
}
