import { join } from "node:path";
import { prisma } from "@gennety/db";
import {
  PROFILE_MEDIA_VALIDATION_VERSION,
  PROFILE_VIDEO_MAX_DURATION_SECONDS,
  PROFILE_VIDEO_NATIVE_MAX_FILE_SIZE_BYTES,
  PROFILE_VIDEO_NATIVE_MIN_DURATION_SECONDS,
  isStorageMediaRef,
  normalizeProfileMedia,
  profileVideoMedia,
  type ProfileMedia,
  type ProfileVideoMedia,
} from "@gennety/shared";
import { env } from "../config.js";
import {
  createProfilePhotoSignedUrl,
  deleteProfileVideoObjects,
  uploadProfileVideoAsset,
} from "./storage.js";
import { profileMediaToJson } from "./profile-media-json.js";
import { validateUserProfileVideo } from "./profile-media-validation/profile-video-validation.js";
import { checkProfileImageSafety } from "./profile-media-validation/photo-validation.js";
import { logMediaValidationRejection } from "./profile-media-validation/rejection-log.js";
import { probeVideo } from "./profile-media-validation/video-probe.js";
import {
  withTempMediaDirectory,
  writePrivateMediaFile,
} from "./profile-media-validation/temp-media.js";
import { sniffImageMime } from "../utils/image-sniff.js";
import { grantVideoBonusIfEligible } from "./ticket-wallet.js";

/**
 * Profile video on the native rail (`POST/DELETE /v1/me/video`, iOS).
 *
 * The Telegram flow (`handlers/menu/video.ts`) keeps the video as a Telegram
 * `file_id`. The app has no Telegram to lean on, so here the bytes go to the
 * profile-photo bucket and the SAME `profileMedia` video slot holds the storage
 * path — one video per profile regardless of which surface recorded it, and the
 * bot, the pitch and the bonus all keep reading one place. Refs are told apart
 * with `isStorageMediaRef`, exactly as photos have always been.
 *
 * What is checked is what the bot checks — safety only (frames + audio
 * transcript); the identity gate was removed on purpose (see
 * `video-validation.ts`). The native rail adds a 3-second floor, a 50 MB
 * ceiling (`PROFILE_VIDEO_NATIVE_*`, reasons in `constants.ts`), and a safety
 * check on the client-made poster, which the bot rail has no equivalent of.
 */

/** Same lifetime as photo URLs — the screen that asks re-reads on open. */
export const PROFILE_VIDEO_SIGNED_URL_TTL_S = 600;

/** The video as the app renders it. `url: null` = exists, but not playable here. */
export interface SerializedProfileVideo {
  url: string | null;
  thumbUrl: string | null;
  duration: number | null;
}

export type SaveProfileVideoError =
  | "invalid_media"
  | "profile_missing"
  | "video_too_short"
  | "video_too_long"
  | "video_too_large_to_check"
  | "unsafe_content"
  | "processing_unavailable"
  | "storage_unavailable"
  /** Any other validation reason the shared validator may add later. */
  | (string & {});

export type SaveProfileVideoResult =
  | {
      ok: true;
      videoUrl: string | null;
      thumbUrl: string | null;
      duration: number;
      bonusGranted: boolean;
    }
  | { ok: false; error: SaveProfileVideoError; retryable: boolean };

export interface SaveProfileVideoInput {
  userId: string;
  video: Buffer;
  thumb: Buffer;
}

class ProfileMissingError extends Error {}

function fail(error: SaveProfileVideoError, retryable: boolean): SaveProfileVideoResult {
  return { ok: false, error, retryable };
}

/**
 * ISO-BMFF (`.mp4`/`.mov`) opens with a box whose type at bytes 4–8 is `ftyp`.
 * A cheap gate before ffprobe and the moderation providers ever see the file.
 */
export function looksLikeIsoMedia(buffer: Buffer): boolean {
  return buffer.byteLength >= 12 && buffer.toString("latin1", 4, 8) === "ftyp";
}

async function measure(
  userId: string,
  video: Buffer,
): Promise<{ ok: true; durationSeconds: number } | { ok: false; error: string; retryable: boolean }> {
  if (env.PROFILE_MEDIA_VALIDATION_ENABLED) {
    const validation = await validateUserProfileVideo({ userId, video });
    if (!validation.ok) {
      return { ok: false, error: validation.reason, retryable: validation.retryable };
    }
    return { ok: true, durationSeconds: validation.value.durationSeconds };
  }
  // Validation off is a local-dev state (config refuses it in production). The
  // duration is still measured: it is part of the contract, not of the safety
  // check, and the app shows it on the card.
  try {
    const probe = await withTempMediaDirectory(async (directory) => {
      const path = join(directory, "input-video");
      await writePrivateMediaFile(path, video);
      return probeVideo(path);
    });
    if (probe.durationSeconds > PROFILE_VIDEO_MAX_DURATION_SECONDS) {
      return { ok: false, error: "video_too_long", retryable: false };
    }
    return { ok: true, durationSeconds: probe.durationSeconds };
  } catch {
    return { ok: false, error: "processing_unavailable", retryable: true };
  }
}

async function sign(ref: string | undefined): Promise<string | null> {
  if (!ref || !isStorageMediaRef(ref)) return null;
  return createProfilePhotoSignedUrl(ref, PROFILE_VIDEO_SIGNED_URL_TTL_S);
}

function videoOf(media: readonly ProfileMedia[]): ProfileVideoMedia | null {
  return media.find((item): item is ProfileVideoMedia => item.type === "video") ?? null;
}

/**
 * Validate, store and attach a native profile video, replacing any previous
 * one (from either surface). Cheap gates first, providers last, storage only
 * for a clip that passed; the row swap runs under the same user-row lock as
 * photo deletes, so a concurrent photo edit cannot resurrect or drop the video.
 */
export async function saveNativeProfileVideo(
  input: SaveProfileVideoInput,
): Promise<SaveProfileVideoResult> {
  const { userId, video, thumb } = input;
  if (!looksLikeIsoMedia(video)) return fail("invalid_media", false);
  if (video.byteLength > PROFILE_VIDEO_NATIVE_MAX_FILE_SIZE_BYTES) {
    return fail("video_too_large_to_check", false);
  }
  const thumbMime = sniffImageMime(thumb);
  if (!thumbMime) return fail("invalid_media", false);

  const exists = await prisma.profile.findUnique({ where: { userId }, select: { userId: true } });
  if (!exists) return fail("profile_missing", false);

  // The poster is the first thing a partner sees — `thumbUrl` on the pitch,
  // shown before a single frame of the video plays — and the client makes it,
  // so nothing ties it to the video at all. It used to be checked for being an
  // image and nothing else (audit A13-M11). It now passes the same safety
  // check as a profile photo, before the far costlier video validation runs.
  //
  // Not replaced by a frame the video validator already moderated, although
  // one exists: those frames are sampled from inside the clip (the first sits
  // ~4% in), so a server-made poster would jump the moment playback starts —
  // the contract promises the FIRST frame — and HEVC/HDR decoded by ffmpeg
  // comes out washed-out where the device's own render does not. Moderating
  // the client's poster costs the same two provider calls and keeps both.
  if (env.PROFILE_MEDIA_VALIDATION_ENABLED) {
    const poster = await checkProfileImageSafety(thumb);
    if (!poster.ok) {
      if (poster.reason === "unsafe_content") {
        await logMediaValidationRejection({
          userId,
          mediaType: "video",
          reason: poster.reason,
        }).catch(() => {});
      }
      return fail(poster.reason, poster.retryable);
    }
  }

  const measured = await measure(userId, video);
  if (!measured.ok) return fail(measured.error, measured.retryable);
  if (measured.durationSeconds < PROFILE_VIDEO_NATIVE_MIN_DURATION_SECONDS) {
    return fail("video_too_short", false);
  }
  const duration = Math.round(measured.durationSeconds * 10) / 10;

  let videoPath: string | undefined;
  let thumbPath: string | undefined;
  try {
    videoPath = (await uploadProfileVideoAsset(userId, "video", video, "video/mp4")).path;
    thumbPath = (await uploadProfileVideoAsset(userId, "thumb", thumb, thumbMime)).path;
  } catch (err) {
    console.warn("[native-profile-video] storage upload failed:", err);
    await deleteProfileVideoObjects([videoPath, thumbPath]);
    return fail("storage_unavailable", true);
  }

  const item = profileVideoMedia({
    video: videoPath,
    thumb: thumbPath,
    duration,
    fileSize: video.byteLength,
    mimeType: "video/mp4",
    validationVersion: PROFILE_MEDIA_VALIDATION_VERSION,
    validatedAt: new Date().toISOString(),
  });

  let replaced: ProfileVideoMedia[];
  try {
    replaced = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT id FROM users WHERE id = $1::uuid FOR UPDATE", userId);
      const profile = await tx.profile.findUnique({
        where: { userId },
        select: { photos: true, profileMedia: true },
      });
      if (!profile) throw new ProfileMissingError();
      const media = normalizeProfileMedia(profile.profileMedia, profile.photos);
      const previous = media.filter((m): m is ProfileVideoMedia => m.type === "video");
      const next = [...media.filter((m) => m.type !== "video"), item];
      await tx.profile.update({
        where: { userId },
        data: { profileMedia: profileMediaToJson(next) },
      });
      return previous;
    });
  } catch (err) {
    await deleteProfileVideoObjects([videoPath, thumbPath]);
    if (err instanceof ProfileMissingError) return fail("profile_missing", false);
    throw err;
  }
  await deleteProfileVideoObjects(replaced.flatMap((old) => [old.video, old.thumb]));

  // After the commit: the bonus re-reads the row and must see the video. A
  // wallet failure is not an upload failure — the video is already saved.
  let bonusGranted = false;
  try {
    bonusGranted = (await grantVideoBonusIfEligible(userId)).granted;
  } catch (err) {
    console.warn("[native-profile-video] video bonus grant failed:", err);
  }

  const [videoUrl, thumbUrl] = await Promise.all([sign(videoPath), sign(thumbPath)]);
  return { ok: true, videoUrl, thumbUrl, duration, bonusGranted };
}

/**
 * Remove the profile video, whichever surface recorded it. Idempotent: no video
 * is not an error. The one-time ticket bonus is not reversed (same as the bot).
 */
export async function removeNativeProfileVideo(userId: string): Promise<{ removed: boolean }> {
  const previous = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT id FROM users WHERE id = $1::uuid FOR UPDATE", userId);
    const profile = await tx.profile.findUnique({
      where: { userId },
      select: { photos: true, profileMedia: true },
    });
    if (!profile) return [];
    const media = normalizeProfileMedia(profile.profileMedia, profile.photos);
    const videos = media.filter((m): m is ProfileVideoMedia => m.type === "video");
    if (videos.length === 0) return [];
    await tx.profile.update({
      where: { userId },
      data: { profileMedia: profileMediaToJson(media.filter((m) => m.type !== "video")) },
    });
    return videos;
  });
  await deleteProfileVideoObjects(previous.flatMap((old) => [old.video, old.thumb]));
  return { removed: previous.length > 0 };
}

/**
 * The owner's video for `GET /v1/me/photos`. A Telegram-recorded video is still
 * reported — with `url: null` — so the app can say one exists and offer to
 * replace or remove it, instead of showing an empty slot the bot contradicts.
 */
export async function serializeOwnProfileVideo(
  photos: readonly string[],
  profileMedia: unknown,
): Promise<SerializedProfileVideo | null> {
  const video = videoOf(normalizeProfileMedia(profileMedia, photos));
  if (!video) return null;
  const [url, thumbUrl] = await Promise.all([sign(video.video), sign(video.thumb)]);
  return { url, thumbUrl, duration: video.duration ?? null };
}

/**
 * The partner's video for the native pitch — only when there is something to
 * play. Entitlement is the caller's (`partner-photos.ts`).
 */
export async function serializePartnerProfileVideo(
  photos: readonly string[],
  profileMedia: unknown,
): Promise<SerializedProfileVideo | null> {
  const own = await serializeOwnProfileVideo(photos, profileMedia);
  return own?.url ? own : null;
}
