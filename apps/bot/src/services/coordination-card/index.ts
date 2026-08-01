import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Api, RawApi } from "grammy";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { Language } from "@gennety/shared";
import { downloadProfileImage } from "../storage.js";
import { butterflyPng, type ButterflyMark } from "../match-card/collage.js";
import { toPngBuffer, grainPng } from "../date-card/image.js";
import { coordCardCopy, type CoordCardVariant } from "./copy.js";
import {
  buildCoordCardElement,
  CARD_W,
  CARD_H,
  type CardNode,
  type CoordCardTheme,
} from "./template.js";

/**
 * Pre-date coordination card renderer (PRODUCT_SPEC §Phase 4).
 *
 * DESIGN STAGE: the renderer is complete and production-shaped, but nothing in
 * the live coordination handlers calls it yet — the family is still being
 * reviewed (see `scripts/dev-coord-cards-demo.mjs`, which renders every variant
 * and DMs them). Wiring it into `handlers/date/coordination.ts` +
 * `services/coordination.ts` is the follow-up step, at which point the copy
 * moves into shared i18n (see `copy.ts`).
 *
 * Same pure satori → resvg stack as the date / match / referral cards (no
 * headless browser). Never throws: returns `null` on any failure so a caller
 * can always fall back to the plain text message it decorates. A coordination
 * DM is time-critical (it lands an hour before the date) and must never wedge
 * on a render.
 */

export type { CoordCardVariant } from "./copy.js";
export type { CoordCardTheme } from "./template.js";

export interface CoordCardInput {
  variant: CoordCardVariant;
  /** Person in the frame and named in the sub line (the asker, or the contact). */
  personName: string;
  /**
   * Their first profile photo (Telegram `file_id` or Supabase path). Ignored by
   * the `declined` / `proxy` variants, which render an emblem instead.
   */
  personPhotoRef?: string | null;
  /** Already-decoded photo bytes; skips the download when a caller has them. */
  personPhoto?: Buffer | null;
  language: Language;
  /** Recipient's chosen theme, exactly like the date card. */
  theme: CoordCardTheme;
}

type SatoriFonts = Parameters<typeof satori>[1]["fonts"];
let cachedFonts: SatoriFonts | null = null;

/**
 * Archivo Black carries no Cyrillic at all, and satori does NOT fall through
 * *within* a family — it primary-matches the first font registered under a
 * name and resolves missing glyphs from the OTHER families in array order. So
 * the Cyrillic display face is registered under its own family name and picked
 * per language below (the same fix `referral-card` documents).
 */
function loadFonts(): SatoriFonts {
  if (cachedFonts) return cachedFonts;
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)));
  cachedFonts = [
    { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: "Roboto", data: read("Roboto-Bold.ttf"), weight: 700, style: "normal" },
    { name: "Archivo Black", data: read("ArchivoBlack-Regular.ttf"), weight: 400, style: "normal" },
    { name: "Headline Cyr", data: read("unbounded-cyr-700.woff"), weight: 400, style: "normal" },
  ];
  return cachedFonts;
}

function headlineFamily(language: Language): string {
  return language === "ru" || language === "uk" ? "Headline Cyr" : "Archivo Black";
}

/** Full-card film-grain tile, generated once and reused for every render. */
let cachedGrain: Buffer | null = null;
function grainTile(): Buffer {
  if (!cachedGrain) cachedGrain = grainPng(CARD_W, CARD_H, 9);
  return cachedGrain;
}

/**
 * Brand butterfly, rasterized per tint and reused. Two tints are in play: the
 * header lockup follows the theme (cream on the dark ground, burgundy on the
 * light one), while the redacted `proxy` frame is always cream because its own
 * ground is burgundy regardless of theme.
 */
const markCache = new Map<string, ButterflyMark | null>();
async function brandMark(width: number, tint: string): Promise<ButterflyMark | null> {
  const key = `${width}:${tint}`;
  const hit = markCache.get(key);
  if (hit !== undefined) return hit;
  const mark = await butterflyPng(width, tint);
  markCache.set(key, mark);
  return mark;
}

export async function renderCoordinationCard(
  input: CoordCardInput,
  api: Api<RawApi>,
): Promise<Buffer | null> {
  try {
    const needsPhoto = input.variant !== "declined" && input.variant !== "proxy";

    // Photo is best-effort: the template keeps the frame and fills it with the
    // brand ground when it is missing, so a dead file_id costs a face, not the card.
    let photo: Buffer | null = null;
    if (needsPhoto) {
      if (input.personPhoto) {
        photo = await toPngBuffer(input.personPhoto);
      } else if (input.personPhotoRef) {
        const downloaded = await downloadProfileImage(input.personPhotoRef, api);
        // Telegram serves JPEG; normalize so the data URI's `image/png` is honest.
        if (downloaded) photo = await toPngBuffer(downloaded);
      }
    }

    const [logo, logoCream] = await Promise.all([
      brandMark(220, input.theme === "light" ? "#8B253B" : "#F7ECEC"),
      input.variant === "proxy" ? brandMark(320, "#F7ECEC") : Promise.resolve(null),
    ]);

    const element = buildCoordCardElement({
      variant: input.variant,
      copy: coordCardCopy(input.language, input.variant, input.personName),
      photo,
      logo,
      logoCream,
      // The dark film grain would dirty the light card's cream ground.
      grain: input.theme === "light" ? null : grainTile(),
      headlineFamily: headlineFamily(input.language),
      theme: input.theme,
    });

    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: CARD_W,
      height: CARD_H,
      fonts: loadFonts(),
    });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: CARD_W } }).render().asPng();
    return Buffer.from(png);
  } catch (err) {
    console.warn("[coordination-card] render failed:", err);
    return null;
  }
}

export type { CardNode };
