import type { Api, RawApi } from "grammy";
import type { InputMediaPhoto, InputMediaVideo, MessageEntity } from "grammy/types";
import type { ProfileMedia } from "@gennety/shared";
import { sendLivePhoto } from "./telegram-live-photo.js";

export interface MediaCaption {
  caption?: string;
  caption_entities?: MessageEntity[];
}

interface InputMediaLivePhoto {
  type: "live_photo";
  media: string;
  photo: string;
  caption?: string;
  caption_entities?: MessageEntity[];
}

type InputProfileMedia = InputMediaPhoto | InputMediaVideo | InputMediaLivePhoto;

export const MAX_TELEGRAM_MEDIA_GROUP_SIZE = 10;

function captionOptions(caption: MediaCaption): {
  caption?: string;
  caption_entities?: MessageEntity[];
} {
  return {
    ...(caption.caption ? { caption: caption.caption } : {}),
    ...(caption.caption && caption.caption_entities?.length
      ? { caption_entities: caption.caption_entities }
      : {}),
  };
}

function toInputMedia(item: ProfileMedia, caption: MediaCaption): InputProfileMedia {
  const captionFields = captionOptions(caption);
  if (item.type === "live_photo") {
    return {
      type: "live_photo",
      media: item.livePhoto,
      photo: item.photo,
      ...captionFields,
    };
  }
  if (item.type === "video") {
    // `thumbnail` only accepts a freshly-uploaded InputFile, not a stored
    // file_id, so we let Telegram auto-generate the poster from the video.
    return {
      type: "video",
      media: item.video,
      ...captionFields,
    };
  }
  return {
    type: "photo",
    media: item.photo,
    ...captionFields,
  };
}

/**
 * Static (live-photo-free) representation for a media group. Live photos and
 * photos collapse to their static frame; videos stay videos (a media group may
 * mix photos and videos).
 */
function toStaticInputMedia(
  item: ProfileMedia,
  caption: MediaCaption,
): InputMediaPhoto | InputMediaVideo {
  if (item.type === "video") {
    return {
      type: "video",
      media: item.video,
      ...captionOptions(caption),
    };
  }
  return {
    type: "photo",
    media: item.photo,
    ...captionOptions(caption),
  };
}

async function sendStaticFallback(
  api: Api<RawApi>,
  chatId: number,
  media: readonly ProfileMedia[],
  caption: MediaCaption,
): Promise<void> {
  if (media.length === 0) return;
  if (media.length === 1) {
    const only = media[0]!;
    if (only.type === "video") {
      await api.sendVideo(chatId, only.video, captionOptions(caption));
    } else {
      await api.sendPhoto(chatId, only.photo, captionOptions(caption));
    }
    return;
  }
  const fallbackMedia = media.map((item, index) =>
    toStaticInputMedia(item, index === 0 ? caption : {}),
  );
  await api.sendMediaGroup(chatId, fallbackMedia);
}

/**
 * Send profile media in Telegram. Live Photo sends use Bot API 10.0 via a
 * narrow raw helper when grammY hasn't typed `sendLivePhoto` yet. Any media
 * failure is swallowed by callers; this helper makes one live->static fallback
 * attempt before surfacing the error.
 */
export async function sendProfileMediaCard(
  api: Api<RawApi>,
  chatId: number,
  media: readonly ProfileMedia[],
  caption: MediaCaption = {},
): Promise<void> {
  const slice = media.slice(0, MAX_TELEGRAM_MEDIA_GROUP_SIZE);
  if (slice.length === 0) return;

  if (slice.length === 1) {
    const item = slice[0]!;
    if (item.type === "live_photo") {
      try {
        await sendLivePhoto(
          api,
          chatId,
          item.livePhoto,
          item.photo,
          captionOptions(caption),
        );
      } catch (err) {
        console.warn("sendLivePhoto failed, falling back to static photo:", err);
        await api.sendPhoto(chatId, item.photo, captionOptions(caption));
      }
      return;
    }

    if (item.type === "video") {
      await api.sendVideo(chatId, item.video, captionOptions(caption));
      return;
    }

    await api.sendPhoto(chatId, item.photo, captionOptions(caption));
    return;
  }

  const inputMedia = slice.map((item, index) =>
    toInputMedia(item, index === 0 ? caption : {}),
  );

  try {
    await api.sendMediaGroup(chatId, inputMedia as unknown as InputMediaPhoto[]);
  } catch (err) {
    if (!slice.some((item) => item.type === "live_photo")) throw err;
    console.warn("sendMediaGroup with live photos failed, falling back to static photos:", err);
    await sendStaticFallback(api, chatId, slice, caption);
  }
}
