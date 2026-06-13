import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Api, RawApi } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { t, type Language } from "@gennety/shared";
import { downloadProfileImage } from "../storage.js";
import { blurFacesInPhoto } from "./face-blur.js";
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

const RENDER_TZ = "Europe/Kyiv";
const LOCALE_TAGS: Record<Language, string> = {
  en: "en-GB",
  ru: "ru-RU",
  uk: "uk-UA",
  de: "de-DE",
  pl: "pl-PL",
};

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
  cachedFonts = [
    { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: "Roboto", data: read("Roboto-Bold.ttf"), weight: 700, style: "normal" },
  ];
  return cachedFonts;
}

function formatDateText(when: Date, language: Language): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[language], {
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: RENDER_TZ,
  }).format(when);
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
    partnerPhoto = await downloadProfileImage(input.partnerPhotoRef, api);
    if (partnerPhoto && opts.blur) {
      partnerPhoto = await blurFacesInPhoto(partnerPhoto);
      if (!partnerPhoto) return null;
    }
  }

  // 2. Venue photo (best-effort; template falls back to a gradient).
  const venuePhoto = await resolveVenuePhoto(input.venuePhotoUrl, input.venuePhotoName);

  // 3. Compose + rasterize.
  try {
    const element = buildCardElement({
      partnerName: input.partnerFirstName,
      partnerPhoto,
      venuePhoto: venuePhoto?.buffer ?? null,
      attribution: venuePhoto?.attribution ?? false,
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      dateText: formatDateText(input.agreedTime, input.language),
      labels: {
        tagline: t(input.language, "dateCardTagline"),
        when: t(input.language, "dateCardWhen"),
        where: t(input.language, "dateCardWhere"),
      },
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
