import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../../config.js";
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

  return validateProfileVideo(
    {
      video: input.video,
      identityReference: reference,
    },
    {
      maximumFrames: env.PROFILE_VIDEO_MAX_ANALYSIS_FRAMES,
      identityThreshold: env.FACE_MATCH_THRESHOLD_VERIFY,
    },
  );
}

function unavailable(): MediaValidationResult<ValidatedVideo> {
  return { ok: false, reason: "processing_unavailable", retryable: true };
}
