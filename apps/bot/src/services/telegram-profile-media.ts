import type { PhotoSize } from "grammy/types";
import {
  LIVE_PHOTO_MAX_DURATION_SECONDS,
  LIVE_PHOTO_MAX_FILE_SIZE_BYTES,
  profileLivePhotoMedia,
  profilePhotoMedia,
  type ProfileMedia,
} from "@gennety/shared";

export interface IncomingTelegramLivePhoto {
  photo?: PhotoSize[];
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export type IncomingProfileMedia =
  | {
      kind: "photo";
      staticPhoto: PhotoSize;
      profileMedia: ProfileMedia;
      uniqueId: string;
    }
  | {
      kind: "live_photo";
      staticPhoto: PhotoSize;
      profileMedia: ProfileMedia;
      uniqueId: string;
    };

export type LivePhotoExtractionResult =
  | { ok: true; media: IncomingProfileMedia }
  | { ok: false; reason: "missing_static" | "too_long" | "too_large" };

export function getMessageLivePhoto(message: unknown): IncomingTelegramLivePhoto | null {
  if (!message || typeof message !== "object") return null;
  const maybe = (message as { live_photo?: unknown }).live_photo;
  if (!maybe || typeof maybe !== "object") return null;
  const livePhoto = maybe as Partial<IncomingTelegramLivePhoto>;
  if (typeof livePhoto.file_id !== "string") return null;
  if (typeof livePhoto.file_unique_id !== "string") return null;
  if (typeof livePhoto.duration !== "number") return null;
  if (typeof livePhoto.width !== "number") return null;
  if (typeof livePhoto.height !== "number") return null;
  return livePhoto as IncomingTelegramLivePhoto;
}

export function bestPhotoSize(photo: readonly PhotoSize[]): PhotoSize | null {
  return photo.length > 0 ? photo[photo.length - 1]! : null;
}

export function incomingPhotoMedia(photo: readonly PhotoSize[]): IncomingProfileMedia | null {
  const staticPhoto = bestPhotoSize(photo);
  if (!staticPhoto) return null;
  return {
    kind: "photo",
    staticPhoto,
    profileMedia: profilePhotoMedia(staticPhoto.file_id),
    uniqueId: staticPhoto.file_unique_id,
  };
}

export function incomingLivePhotoMedia(
  livePhoto: IncomingTelegramLivePhoto,
): LivePhotoExtractionResult {
  if (livePhoto.duration > LIVE_PHOTO_MAX_DURATION_SECONDS) {
    return { ok: false, reason: "too_long" };
  }

  if (
    typeof livePhoto.file_size === "number" &&
    livePhoto.file_size > LIVE_PHOTO_MAX_FILE_SIZE_BYTES
  ) {
    return { ok: false, reason: "too_large" };
  }

  const staticPhoto = bestPhotoSize(livePhoto.photo ?? []);
  if (!staticPhoto) {
    return { ok: false, reason: "missing_static" };
  }

  const profileMediaArgs: Parameters<typeof profileLivePhotoMedia>[0] = {
    photo: staticPhoto.file_id,
    livePhoto: livePhoto.file_id,
    duration: livePhoto.duration,
    width: livePhoto.width,
    height: livePhoto.height,
  };
  if (livePhoto.file_size !== undefined) profileMediaArgs.fileSize = livePhoto.file_size;
  if (livePhoto.mime_type !== undefined) profileMediaArgs.mimeType = livePhoto.mime_type;

  return {
    ok: true,
    media: {
      kind: "live_photo",
      staticPhoto,
      profileMedia: profileLivePhotoMedia(profileMediaArgs),
      uniqueId: staticPhoto.file_unique_id,
    },
  };
}
