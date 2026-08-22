/**
 * Delivery of the collage match-card set as the pitch's leading visual —
 * the feature-flagged replacement for the plain partner-photo media group
 * (PRODUCT_SPEC.md §3.3).
 *
 * Contract: `sendPartnerMatchCards` returns `{ sent: false }` only when the
 * caller MUST fall back to the classic media group — flag off, no usable
 * photos, copy or render failure, send failure — so pitch dispatch never
 * wedges. `{ sent: true }` additionally reports the motion the album could
 * not take (see below).
 *
 * The partner's MOTION (profile video, Live Photo motion part) rides in this
 * same album rather than in a follow-up message: a Telegram media group may
 * mix photos and videos, which the classic path has always relied on
 * (`profile-media-dispatch.ts`). Sending it separately cost the pitch an extra
 * bubble for no platform reason. Static frames are deliberately NOT re-sent —
 * they are already inside the rendered PNGs, which is what
 * `motionOnlyProfileMedia` exists to express.
 *
 * Accepted tradeoff (founder decision 2026-08-22): the card set is a designed
 * "paper" composition and the video arrives as a raw frame with a play button
 * in the last tile. A branded poster via `thumbnail` was declined — Telegram is
 * not known to apply a custom thumbnail to a video referenced by `file_id`, and
 * `profile-media-dispatch.ts` records that `thumbnail` takes a freshly-uploaded
 * `InputFile` only.
 */
import { InputFile } from "grammy";
import type { Api, RawApi } from "grammy";
import type { InputMediaPhoto, InputMediaVideo, MessageEntity } from "grammy/types";
import { MAX_PHOTOS, type Language, type ProfileMedia } from "@gennety/shared";
import { env } from "../../config.js";
import { PROTECT_PARTNER_MEDIA } from "../../demo/config.js";
import { downloadProfileImage } from "../storage.js";
import {
  MAX_TELEGRAM_MEDIA_GROUP_SIZE,
  motionOnlyProfileMedia,
} from "../profile-media-dispatch.js";
import { generateMatchCardTexts } from "./copy.js";
import { renderMatchCardSet, type MatchCardTheme } from "./index.js";

/** One rendered card holds two photos, so 10 profile photos become five cards. */
const MAX_CARD_PHOTOS = MAX_PHOTOS;

/** A motion item as `motionOnlyProfileMedia` emits it — always a video. */
type MotionMedia = Extract<ProfileMedia, { type: "video" }>;

export type PartnerMatchCardsResult =
  /** Caller must fall back to the classic photo media group. */
  | { sent: false }
  /**
   * Cards delivered. `motionOverflow` is the motion that did not fit the
   * 10-item group cap and still needs its own send — empty in every ordinary
   * case (5 cards max, and a profile carries one video), non-empty only for a
   * profile made almost entirely of Live Photos.
   */
  | { sent: true; motionOverflow: readonly ProfileMedia[] };

export interface PartnerMatchCardsInput {
  matchId: string;
  /** Recipient side — only differentiates the collage jitter seed. */
  side: "A" | "B";
  partnerFirstName: string | null;
  partnerAge: number | null;
  partnerSummary: string | null;
  /** Partner's static profile photos (Telegram file_id / Supabase path). */
  photos: readonly string[];
  /**
   * Partner's normalized profile media. Only its motion is used — the static
   * frames are already rendered into the cards.
   */
  profileMedia: readonly ProfileMedia[];
  language: Language;
  /** Recipient's chosen theme — renders the paper set light or dark. */
  theme: MatchCardTheme;
  /** Album caption (name/age + verified affordance), shown on the first card. */
  caption: { caption: string; entities?: MessageEntity[] };
}

export async function sendPartnerMatchCards(
  api: Api<RawApi>,
  chatId: number,
  input: PartnerMatchCardsInput,
): Promise<PartnerMatchCardsResult> {
  if (!env.MATCH_CARD_FEATURE_ENABLED) return { sent: false };
  try {
    const refs = input.photos.slice(0, MAX_CARD_PHOTOS);
    if (refs.length === 0) return { sent: false };
    const downloads = await Promise.all(refs.map((ref) => downloadProfileImage(ref, api)));
    const photos = downloads.filter((buf): buf is Buffer => buf != null && buf.length > 0);
    if (photos.length === 0) return { sent: false };

    const texts = await generateMatchCardTexts({
      partnerFirstName: input.partnerFirstName,
      partnerAge: input.partnerAge,
      partnerSummary: input.partnerSummary,
      language: input.language,
    });
    if (!texts) return { sent: false };

    const cards = await renderMatchCardSet({
      photos,
      texts,
      seed: `${input.matchId}:${input.side}`,
      theme: input.theme,
    });
    if (!cards || cards.length === 0) return { sent: false };

    const { caption, entities } = input.caption;
    const media: (InputMediaPhoto | InputMediaVideo)[] = cards.map((png, i) => ({
      type: "photo",
      media: new InputFile(png, `match-card-${i + 1}.png`),
      ...(i === 0 && caption
        ? { caption, ...(entities?.length ? { caption_entities: entities } : {}) }
        : {}),
    }));

    // Motion fills whatever the group has left. The cap is Telegram's, not
    // ours: exceeding it fails the whole send, which would cost the user the
    // photos as well as the video.
    const motion = motionOnlyProfileMedia(input.profileMedia).filter(
      (item): item is MotionMedia => item.type === "video",
    );
    const slots = Math.max(0, MAX_TELEGRAM_MEDIA_GROUP_SIZE - media.length);
    for (const item of motion.slice(0, slots)) {
      // No caption: it belongs to the first card, which carries the partner's
      // name and the verified affordance.
      media.push({ type: "video", media: item.video });
    }

    // Same protection as the plain media group: the pitch is the first place
    // a user sees the partner (PRODUCT_SPEC §3.7a). Off in demo mode, so the
    // cards survive a screen recording (`PROTECT_PARTNER_MEDIA`).
    await api.sendMediaGroup(chatId, media, { protect_content: PROTECT_PARTNER_MEDIA });
    return { sent: true, motionOverflow: motion.slice(slots) };
  } catch (err) {
    console.warn("[match-card] card-set send failed, falling back to plain media:", err);
    return { sent: false };
  }
}
