/**
 * Delivery of the collage match-card set as the pitch's leading visual —
 * the feature-flagged replacement for the plain partner-photo media group
 * (PRODUCT_SPEC.md §3.3).
 *
 * Contract: `sendPartnerMatchCards` returns `true` only when the card album
 * actually reached Telegram. `false` — flag off, no usable photos, copy or
 * render failure, send failure — means the caller MUST fall back to the
 * classic media group so pitch dispatch never wedges.
 *
 * Known v1 tradeoff: cards render from static `photos[]` only, so a partner's
 * profile video / Live Photo motion is not shown when cards are on (the
 * static frames are). The fallback path still sends the full rich album.
 */
import { InputFile } from "grammy";
import type { Api, RawApi } from "grammy";
import type { InputMediaPhoto, MessageEntity } from "grammy/types";
import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { downloadProfileImage } from "../storage.js";
import { generateMatchCardTexts } from "./copy.js";
import { renderMatchCardSet } from "./index.js";

/** Telegram albums cap at 10; profiles cap at MAX_PHOTOS (6) anyway. */
const MAX_CARD_PHOTOS = 6;

export interface PartnerMatchCardsInput {
  matchId: string;
  /** Recipient side — only differentiates the collage jitter seed. */
  side: "A" | "B";
  partnerFirstName: string | null;
  partnerAge: number | null;
  partnerSummary: string | null;
  /** Partner's static profile photos (Telegram file_id / Supabase path). */
  photos: readonly string[];
  language: Language;
  /** Album caption (name/age + verified affordance), shown on the first card. */
  caption: { caption: string; entities?: MessageEntity[] };
}

export async function sendPartnerMatchCards(
  api: Api<RawApi>,
  chatId: number,
  input: PartnerMatchCardsInput,
): Promise<boolean> {
  if (!env.MATCH_CARD_FEATURE_ENABLED) return false;
  try {
    const refs = input.photos.slice(0, MAX_CARD_PHOTOS);
    if (refs.length === 0) return false;
    const downloads = await Promise.all(refs.map((ref) => downloadProfileImage(ref, api)));
    const photos = downloads.filter((buf): buf is Buffer => buf != null && buf.length > 0);
    if (photos.length === 0) return false;

    const texts = await generateMatchCardTexts({
      partnerFirstName: input.partnerFirstName,
      partnerAge: input.partnerAge,
      partnerSummary: input.partnerSummary,
      language: input.language,
    });
    if (!texts) return false;

    const cards = await renderMatchCardSet({
      photos,
      texts,
      seed: `${input.matchId}:${input.side}`,
    });
    if (!cards || cards.length === 0) return false;

    const { caption, entities } = input.caption;
    const media: InputMediaPhoto[] = cards.map((png, i) => ({
      type: "photo",
      media: new InputFile(png, `match-card-${i + 1}.png`),
      ...(i === 0 && caption
        ? { caption, ...(entities?.length ? { caption_entities: entities } : {}) }
        : {}),
    }));
    // Same protection as the plain media group: the pitch is the first place
    // a user sees the partner (PRODUCT_SPEC §3.7a).
    await api.sendMediaGroup(chatId, media, { protect_content: true });
    return true;
  } catch (err) {
    console.warn("[match-card] card-set send failed, falling back to plain media:", err);
    return false;
  }
}
