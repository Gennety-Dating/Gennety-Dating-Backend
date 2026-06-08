export interface ProfilePhotoMedia {
  type: "photo";
  photo: string;
}

export interface ProfileLivePhotoMedia {
  type: "live_photo";
  /** Static frame used for face validation, face-match, and fallback sends. */
  photo: string;
  /** Telegram file_id of the Live Photo video part. */
  livePhoto: string;
  duration?: number;
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
}

export interface ProfileVideoMedia {
  type: "video";
  /** Telegram file_id of the video part. Display-only — NOT face-matched. */
  video: string;
  /** Optional poster/thumbnail file_id for the card. */
  thumb?: string;
  duration?: number;
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
}

export type ProfileMedia =
  | ProfilePhotoMedia
  | ProfileLivePhotoMedia
  | ProfileVideoMedia;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function profilePhotoMedia(photo: string): ProfilePhotoMedia {
  return { type: "photo", photo };
}

export function profileLivePhotoMedia(args: {
  photo: string;
  livePhoto: string;
  duration?: number;
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
}): ProfileLivePhotoMedia {
  return {
    type: "live_photo",
    photo: args.photo,
    livePhoto: args.livePhoto,
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
    ...(args.width !== undefined ? { width: args.width } : {}),
    ...(args.height !== undefined ? { height: args.height } : {}),
    ...(args.fileSize !== undefined ? { fileSize: args.fileSize } : {}),
    ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
  };
}

export function profileVideoMedia(args: {
  video: string;
  thumb?: string;
  duration?: number;
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
}): ProfileVideoMedia {
  return {
    type: "video",
    video: args.video,
    ...(args.thumb !== undefined ? { thumb: args.thumb } : {}),
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
    ...(args.width !== undefined ? { width: args.width } : {}),
    ...(args.height !== undefined ? { height: args.height } : {}),
    ...(args.fileSize !== undefined ? { fileSize: args.fileSize } : {}),
    ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
  };
}

export function parseProfileMediaItem(value: unknown): ProfileMedia | null {
  if (!isRecord(value)) return null;

  // Video items carry no static `photo` — handle before the photo guard.
  if (value.type === "video") {
    const video = cleanString(value.video);
    if (!video) return null;
    const args: Parameters<typeof profileVideoMedia>[0] = { video };
    const thumb = cleanString(value.thumb);
    const duration = cleanNumber(value.duration);
    const width = cleanNumber(value.width);
    const height = cleanNumber(value.height);
    const fileSize = cleanNumber(value.fileSize);
    const mimeType = cleanString(value.mimeType);
    if (thumb !== null) args.thumb = thumb;
    if (duration !== undefined) args.duration = duration;
    if (width !== undefined) args.width = width;
    if (height !== undefined) args.height = height;
    if (fileSize !== undefined) args.fileSize = fileSize;
    if (mimeType !== null) args.mimeType = mimeType;
    return profileVideoMedia(args);
  }

  const photo = cleanString(value.photo);
  if (!photo) return null;

  if (value.type === "photo") {
    return profilePhotoMedia(photo);
  }

  if (value.type === "live_photo") {
    const livePhoto = cleanString(value.livePhoto);
    if (!livePhoto) return null;
    const args: Parameters<typeof profileLivePhotoMedia>[0] = { photo, livePhoto };
    const duration = cleanNumber(value.duration);
    const width = cleanNumber(value.width);
    const height = cleanNumber(value.height);
    const fileSize = cleanNumber(value.fileSize);
    const mimeType = cleanString(value.mimeType);
    if (duration !== undefined) args.duration = duration;
    if (width !== undefined) args.width = width;
    if (height !== undefined) args.height = height;
    if (fileSize !== undefined) args.fileSize = fileSize;
    if (mimeType !== null) args.mimeType = mimeType;
    return profileLivePhotoMedia(args);
  }

  return null;
}

/**
 * Normalize `Profile.profileMedia[]` into displayable media. Legacy rows have
 * only `photos[]`, so an empty or unusable structured array falls back to
 * one photo item per static photo.
 */
export function normalizeProfileMedia(
  profileMedia: unknown,
  photos: readonly string[] = [],
): ProfileMedia[] {
  const parsed = Array.isArray(profileMedia)
    ? profileMedia
        .map(parseProfileMediaItem)
        .filter((item): item is ProfileMedia => item !== null)
    : [];

  // Video items have no static photo, so align the structured array against
  // `photos[]` by its STATIC-photo count (photo + live_photo), not its total
  // length — otherwise a profile with a video would fail the guard and lose
  // the video on the photos-only fallback.
  if (parsed.length > 0) {
    const staticCount = parsed.filter((m) => m.type !== "video").length;
    if (photos.length === 0 || staticCount === photos.length) {
      return parsed;
    }
  }

  return photos
    .map((photo) => cleanString(photo))
    .filter((photo): photo is string => photo !== null)
    .map(profilePhotoMedia);
}

/**
 * Ordered static photos (the `photos[]` / `photoFaceScores[]` source). Video
 * items have no static frame and are excluded, preserving the
 * `photos[i] ↔ photoFaceScores[i]` face-match invariant.
 */
export function staticPhotosFromProfileMedia(media: readonly ProfileMedia[]): string[] {
  return media
    .filter((item): item is ProfilePhotoMedia | ProfileLivePhotoMedia => item.type !== "video")
    .map((item) => item.photo);
}

/** True if the structured media array contains at least one video item. */
export function profileMediaHasVideo(media: readonly ProfileMedia[]): boolean {
  return media.some((item) => item.type === "video");
}
