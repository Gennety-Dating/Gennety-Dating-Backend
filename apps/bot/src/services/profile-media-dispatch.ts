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

/** Merge caption options with an optional `protect_content` flag. */
function sendExtra(
  caption: MediaCaption,
  protect: boolean,
): ReturnType<typeof captionOptions> & { protect_content?: boolean } {
  return { ...captionOptions(caption), ...(protect ? { protect_content: true } : {}) };
}

async function sendStaticFallback(
  api: Api<RawApi>,
  chatId: number,
  media: readonly ProfileMedia[],
  caption: MediaCaption,
  protect: boolean,
): Promise<void> {
  if (media.length === 0) return;
  if (media.length === 1) {
    const only = media[0]!;
    if (only.type === "video") {
      await api.sendVideo(chatId, only.video, sendExtra(caption, protect));
    } else {
      await api.sendPhoto(chatId, only.photo, sendExtra(caption, protect));
    }
    return;
  }
  const fallbackMedia = media.map((item, index) =>
    toStaticInputMedia(item, index === 0 ? caption : {}),
  );
  await api.sendMediaGroup(
    chatId,
    fallbackMedia,
    protect ? { protect_content: true } : undefined,
  );
}

/** Send one Telegram-compatible chunk (1–10 media items). */
async function sendProfileMediaChunk(
  api: Api<RawApi>,
  chatId: number,
  media: readonly ProfileMedia[],
  caption: MediaCaption,
  protect: boolean,
): Promise<void> {
  if (media.length === 0) return;

  if (media.length === 1) {
    const item = media[0]!;
    if (item.type === "live_photo") {
      try {
        await sendLivePhoto(
          api,
          chatId,
          item.livePhoto,
          item.photo,
          sendExtra(caption, protect),
        );
      } catch (err) {
        console.warn("sendLivePhoto failed, falling back to static photo:", err);
        await api.sendPhoto(chatId, item.photo, sendExtra(caption, protect));
      }
      return;
    }

    if (item.type === "video") {
      await api.sendVideo(chatId, item.video, sendExtra(caption, protect));
      return;
    }

    await api.sendPhoto(chatId, item.photo, sendExtra(caption, protect));
    return;
  }

  const inputMedia = media.map((item, index) =>
    toInputMedia(item, index === 0 ? caption : {}),
  );

  try {
    await api.sendMediaGroup(
      chatId,
      inputMedia as unknown as InputMediaPhoto[],
      protect ? { protect_content: true } : undefined,
    );
  } catch (err) {
    if (!media.some((item) => item.type === "live_photo")) throw err;
    console.warn("sendMediaGroup with live photos failed, falling back to static photos:", err);
    await sendStaticFallback(api, chatId, media, caption, protect);
  }
}

/**
 * Send every profile media item in Telegram. Live Photo sends use Bot API
 * 10.0 via a narrow raw helper when grammY hasn't typed `sendLivePhoto` yet.
 * Profiles may contain 10 photos plus one optional video, so the payload is
 * split into Telegram-compatible groups instead of silently truncating the
 * video. Only the first chunk carries the caption.
 */
export async function sendProfileMediaCard(
  api: Api<RawApi>,
  chatId: number,
  media: readonly ProfileMedia[],
  caption: MediaCaption = {},
  options: { protect?: boolean } = {},
): Promise<void> {
  const protect = options.protect ?? false;
  for (let offset = 0; offset < media.length; offset += MAX_TELEGRAM_MEDIA_GROUP_SIZE) {
    const chunk = media.slice(offset, offset + MAX_TELEGRAM_MEDIA_GROUP_SIZE);
    await sendProfileMediaChunk(api, chatId, chunk, offset === 0 ? caption : {}, protect);
  }
}

/**
 * Return only the moving parts of a profile. Match-card PNGs already contain
 * every static photo, including the poster frame of a Live Photo, so sending
 * those frames again would duplicate the profile. Both standalone videos and
 * Live Photo motion parts are represented as Telegram videos here.
 */
export function motionOnlyProfileMedia(
  media: readonly ProfileMedia[],
): ProfileMedia[] {
  return media.flatMap((item) => {
    if (item.type === "photo") return [];
    if (item.type === "video") return [item];
    return [
      {
        type: "video" as const,
        video: item.livePhoto,
        ...(item.duration !== undefined ? { duration: item.duration } : {}),
        ...(item.width !== undefined ? { width: item.width } : {}),
        ...(item.height !== undefined ? { height: item.height } : {}),
        ...(item.fileSize !== undefined ? { fileSize: item.fileSize } : {}),
        ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
      },
    ];
  });
}

/**
 * Send profile motion after a successful static Match Card delivery. This is
 * deliberately caption-free: the card already carries the partner identity
 * and verification caption. Telegram privacy protection matches the card.
 */
export async function sendMotionProfileMedia(
  api: Api<RawApi>,
  chatId: number,
  media: readonly ProfileMedia[],
  options: { protect?: boolean } = {},
): Promise<void> {
  const motion = motionOnlyProfileMedia(media);
  if (motion.length <= 1) {
    await sendProfileMediaCard(api, chatId, motion, {}, options);
    return;
  }

  try {
    await sendProfileMediaCard(api, chatId, motion, {}, options);
  } catch (groupError) {
    // Some Telegram clients/file combinations reject mixed or stale video
    // groups. Fall back to independent protected videos so one bad motion
    // asset does not hide the rest of the profile.
    let delivered = 0;
    for (const item of motion) {
      if (item.type !== "video") continue;
      try {
        await api.sendVideo(chatId, item.video, {
          ...(options.protect ? { protect_content: true } : {}),
        });
        delivered++;
      } catch (err) {
        console.warn("sendMotionProfileMedia individual video failed, skipping:", err);
      }
    }
    if (delivered === 0) throw groupError;
  }
}
