import type { Api } from "grammy";
import {
  PROFILE_MEDIA_VALIDATION_VERSION,
  PROFILE_VIDEO_MAX_FILE_SIZE_BYTES,
  t,
  type Language,
  type ProfileVideoMedia,
} from "@gennety/shared";
import { env } from "../config.js";
import { downloadTelegramFile } from "./storage.js";
import { validateUserProfileVideo } from "./profile-media-validation/profile-video-validation.js";
import type { MediaValidationReason } from "./profile-media-validation/types.js";
import { runStatusSequence } from "./ai-stream.js";
import { videoCheckSteps } from "./analysis-status.js";

/**
 * Deliberate pad held on the final "last checks" video-status beat AFTER the
 * real validation has settled, so the thinking sequence never flashes away the
 * instant a fast check returns. The video validation runs in parallel with the
 * pacing beats; this only extends the held tail by a couple of seconds.
 */
const VIDEO_CHECK_STATUS_PAD_MS = 1_800;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Localized "video added to your profile" acknowledgement. Shared by the
 * onboarding media stage and the post-onboarding profile-video editor so both
 * surfaces speak with one voice.
 */
export function videoSavedAck(language: Language): string {
  switch (language) {
    case "ru":
      return "Видео добавлено в профиль ✅";
    case "uk":
      return "Відео додано до профілю ✅";
    case "de":
      return "Video zum Profil hinzugefügt ✅";
    case "pl":
      return "Wideo dodane do profilu ✅";
    default:
      return "Video added to your profile ✅";
  }
}

/** Map a video validation rejection reason to its localized user-facing copy. */
export function videoValidationMessage(
  language: Language,
  reason: MediaValidationReason,
): string {
  switch (reason) {
    case "unsafe_content":
      return t(language, "videoUnsafeContent");
    case "video_owner_missing":
      return t(language, "videoOwnerMissing");
    case "video_owner_too_brief":
      return t(language, "videoOwnerTooBrief");
    case "identity_mismatch":
      return t(language, "videoIdentityMismatch");
    case "video_mostly_other_person":
      return t(language, "videoMostlyOtherPerson");
    case "video_identity_reference_missing":
      return t(language, "videoNeedsPhotoFirst");
    case "video_too_large_to_check":
      return t(language, "videoTooLarge", {
        mb: Math.round(PROFILE_VIDEO_MAX_FILE_SIZE_BYTES / (1024 * 1024)),
      });
    case "video_too_long":
      return t(language, "videoTooLong");
    default:
      return t(language, "videoProcessingUnavailable");
  }
}

export type PrepareProfileVideoResult =
  | { kind: "accepted"; media: ProfileVideoMedia; statusAcknowledged: boolean }
  | { kind: "rejected" };

/**
 * Validate an incoming profile video and return the media to persist.
 *
 * Shared by the onboarding media stage and the post-onboarding profile-video
 * editor. This is the single source of truth for the safety check + the
 * "reviewing your video" thinking shimmer + the rejection copy. It deliberately
 * does NOT persist, grant the ticket bonus, or send the success ack — those
 * differ between onboarding (session-backed) and the menu (DB-backed), so each
 * caller owns them.
 *
 * When `PROFILE_MEDIA_VALIDATION_ENABLED` is off the media passes through
 * unchanged with `statusAcknowledged: false`. When on, the shimmer covers the
 * download + validate work; a download/processing failure or a confidently
 * unsafe clip replies with the localized reason and returns `rejected`.
 */
export async function prepareProfileVideo(args: {
  api: Api;
  chatId: number;
  userId: string;
  language: Language;
  media: ProfileVideoMedia;
  profilePhotoRefs: readonly string[];
  /** Sends a user-facing message (rejection / unavailable copy) — typically `ctx.reply`. */
  reply: (text: string) => Promise<unknown>;
}): Promise<PrepareProfileVideoResult> {
  const { api, chatId, userId, language, media, profilePhotoRefs, reply } = args;

  if (!env.PROFILE_MEDIA_VALIDATION_ENABLED) {
    return { kind: "accepted", media, statusAcknowledged: false };
  }

  // Download + validate run as one work-promise so the thinking shimmer can
  // cover it; any download/processing failure collapses to "unavailable".
  const work: Promise<
    | { kind: "unavailable" }
    | { kind: "validated"; validation: Awaited<ReturnType<typeof validateUserProfileVideo>> }
  > = (async () => {
    try {
      const videoBytes = await downloadTelegramFile(api, media.video);
      if (!videoBytes) return { kind: "unavailable" as const };
      const validation = await validateUserProfileVideo({
        userId,
        video: videoBytes,
        profilePhotoRefs,
        api,
      });
      return { kind: "validated" as const, validation };
    } catch (err) {
      console.warn("profile video validation failed:", err);
      return { kind: "unavailable" as const };
    }
  })();

  // Stream the "reviewing your video" thinking beats while `work` runs. The
  // first two beats always play (untilFromStepIndex: 2); the final beat is held
  // until validation settles plus a short deliberate pad, then the status is
  // torn down before the verdict lands in its place.
  await runStatusSequence(api, chatId, videoCheckSteps(language), {
    until: work.then(() => delay(VIDEO_CHECK_STATUS_PAD_MS)),
    untilFromStepIndex: 2,
    rich: true,
  }).catch(() => undefined);

  const outcome = await work;
  if (outcome.kind === "unavailable") {
    await reply(t(language, "videoProcessingUnavailable"));
    return { kind: "rejected" };
  }
  if (!outcome.validation.ok) {
    await reply(videoValidationMessage(language, outcome.validation.reason));
    return { kind: "rejected" };
  }

  return {
    kind: "accepted",
    statusAcknowledged: false,
    media: {
      ...media,
      validationVersion: PROFILE_MEDIA_VALIDATION_VERSION,
      validatedAt: new Date().toISOString(),
    },
  };
}
