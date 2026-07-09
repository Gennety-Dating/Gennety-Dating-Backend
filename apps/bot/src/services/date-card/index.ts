import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Api, RawApi } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { t, type Language } from "@gennety/shared";
import { downloadProfileImage } from "../storage.js";
import { butterflyPng, type ButterflyMark } from "../match-card/collage.js";
import { blurFacesInPhoto } from "./face-blur.js";
import { toPngBuffer, duotonePng, grainPng } from "./image.js";
import { resolveVenuePhoto } from "./photo-source.js";
import { buildCardElement, CARD_W, CARD_H, type CardNode } from "./template.js";

/**
 * Date-card renderer (PRODUCT_SPEC.md §3.7). Produces a shareable PNG for a
 * fully `scheduled` date. Two renders share one layout:
 *   - private card (`blur: false`) — real partner face, sent screenshot/
 *     forward-protected;
 *   - share card (`blur: true`) — partner's face pixelated so it can leave the
 *     platform.
 *
 * `renderDateCard` never throws: it returns `null` on any failure so callers
 * fall back to the plain-text scheduled DM (scheduling must never wedge).
 */

export interface DateCardInput {
  /** The *partner* shown on this card (recipient sees the other person). */
  partnerFirstName: string;
  /** First profile photo of the partner (Telegram file_id or Supabase path). */
  partnerPhotoRef: string | null;
  venueName: string;
  venueAddress: string;
  venuePhotoUrl: string | null;
  venuePhotoName: string | null;
  agreedTime: Date;
  language: Language;
}

export interface RenderDateCardOptions {
  /** When true, the partner's face is blurred for an off-platform share copy. */
  blur: boolean;
}

type SatoriFonts = Parameters<typeof satori>[1]["fonts"];
let cachedFonts: SatoriFonts | null = null;

function loadFonts(): SatoriFonts {
  if (cachedFonts) return cachedFonts;
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)));
  const archivoBlack = read("ArchivoBlack-Regular.ttf");
  cachedFonts = [
    { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: "Roboto", data: read("Roboto-Bold.ttf"), weight: 700, style: "normal" },
    // Archivo Black is a single heavy weight — register it under 400 and 700.
    { name: "Archivo Black", data: archivoBlack, weight: 400, style: "normal" },
    { name: "Archivo Black", data: archivoBlack, weight: 700, style: "normal" },
  ];
  return cachedFonts;
}

/** Full-card film-grain tile, generated once and reused for every render. */
let cachedGrain: Buffer | null = null;
function grainTile(): Buffer {
  if (!cachedGrain) cachedGrain = grainPng(CARD_W, CARD_H, 9);
  return cachedGrain;
}

/**
 * Brand butterfly mark, rasterized once and reused for every render. The
 * burgundy radial gradient is baked into `butterfly-logo.svg`, so no tint is
 * applied here. Shared with the match-card renderer.
 */
let cachedLogo: ButterflyMark | null | undefined;
async function loadLogo(): Promise<ButterflyMark | null> {
  if (cachedLogo !== undefined) return cachedLogo;
  cachedLogo = await butterflyPng(600);
  return cachedLogo;
}

export async function renderDateCard(
  input: DateCardInput,
  opts: RenderDateCardOptions,
  api: Api<RawApi>,
): Promise<Buffer | null> {
  // 1. Partner photo (blurred for share). A blur that fails must never fall
  //    back to the clear original — abort the whole card instead.
  let partnerPhoto: Buffer | null = null;
  if (input.partnerPhotoRef) {
    const downloaded = await downloadProfileImage(input.partnerPhotoRef, api);
    if (downloaded) {
      // Normalize to real PNG so the data URI's `image/png` mime is honest
      // (Telegram photos are JPEG). The blur path already re-encodes via canvas.
      partnerPhoto = opts.blur
        ? await blurFacesInPhoto(downloaded)
        : await toPngBuffer(downloaded);
      // Blur that can't be produced must never leak the clear original.
      if (opts.blur && !partnerPhoto) return null;
    }
  }

  // 2. Venue photo (best-effort; template falls back to a gradient). Duotone it
  //    into the brand palette so a stock Places/curated photo reads as part of
  //    the card. Falls back to a plain PNG, then to the gradient, on failure.
  const venueRaw = await resolveVenuePhoto(input.venuePhotoUrl, input.venuePhotoName);
  let venuePhoto: Buffer | null = null;
  if (venueRaw) {
    venuePhoto =
      (await duotonePng(venueRaw.buffer, "#1C0710", "#F7E7EB", 1000, 690, 0.7)) ??
      (await toPngBuffer(venueRaw.buffer));
  }

  // Brand logo (best-effort; absent → no logo, never blocks the render).
  const logo = await loadLogo();

  // 3. Compose + rasterize.
  try {
    const element = buildCardElement({
      partnerName: input.partnerFirstName,
      partnerPhoto,
      venuePhoto,
      grain: grainTile(),
      logo,
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      slogan: t(input.language, "dateCardSlogan"),
    });

    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: CARD_W,
      height: CARD_H,
      fonts: loadFonts(),
    });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: CARD_W } })
      .render()
      .asPng();
    return Buffer.from(png);
  } catch (err) {
    console.warn("[date-card] render failed:", err);
    return null;
  }
}

/** The "Share this card" inline button appended to the private card. */
export function buildShareButton(matchId: string, language: Language): InlineKeyboardButton {
  return { text: t(language, "matchScheduledBtnShare"), callback_data: `datecard:share:${matchId}` };
}

export type { CardNode };
