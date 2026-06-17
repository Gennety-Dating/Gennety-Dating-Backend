import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  FACE_SIMILARITY_THRESHOLD,
  VIDEO_SAMPLE_TARGET_FRAMES,
} from "@gennety/shared";
import {
  downloadProfilePhoto,
  downloadSelfie,
  downloadTelegramFile,
} from "../storage.js";
import {
  validateProfileVideo,
  type ValidatedVideo,
} from "./video-validation.js";
import type { MediaValidationResult } from "./types.js";
import { logMediaValidationRejection } from "./rejection-log.js";

export interface ValidateUserProfileVideoInput {
  userId: string;
  video: Buffer;
  profilePhotoRefs: readonly string[];
  api?: Api<RawApi> | null;
}

export async function validateUserProfileVideo(
  input: ValidateUserProfileVideoInput,
): Promise<MediaValidationResult<ValidatedVideo>> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { verifiedSelfiePath: true },
  });
  if (!user) return unavailable();

  let reference: Buffer | null = null;
  if (user.verifiedSelfiePath) {
    reference = await downloadSelfie(user.verifiedSelfiePath);
  } else {
    const firstPhoto = input.profilePhotoRefs[0];
    if (!firstPhoto) {
      return {
        ok: false,
        reason: "video_identity_reference_missing",
        retryable: false,
      };
    }
    reference = firstPhoto.includes("/")
      ? await downloadProfilePhoto(firstPhoto)
      : input.api
        ? await downloadTelegramFile(input.api, firstPhoto)
        : null;
  }
  if (!reference) return unavailable();

  const result = await validateProfileVideo(
    {
      video: input.video,
      identityReference: reference,
    },
    {
      maximumFrames: VIDEO_SAMPLE_TARGET_FRAMES,
      identityThreshold: FACE_SIMILARITY_THRESHOLD,
    },
  );
  if (!result.ok) {
    await logMediaValidationRejection({
      userId: input.userId,
      mediaType: "video",
      reason: result.reason,
    });
  }
  return result;
}

function unavailable(): MediaValidationResult<ValidatedVideo> {
  return { ok: false, reason: "processing_unavailable", retryable: true };
}
