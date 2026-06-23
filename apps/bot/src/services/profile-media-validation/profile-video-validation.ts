import type { Api, RawApi } from "grammy";
import {
  validateProfileVideo,
  type ValidatedVideo,
} from "./video-validation.js";
import type { MediaValidationResult } from "./types.js";
import { logMediaValidationRejection } from "./rejection-log.js";

export interface ValidateUserProfileVideoInput {
  userId: string;
  video: Buffer;
  /**
   * Retained for call-site compatibility. The profile video no longer carries
   * an identity gate, so the owner's photos are not needed as a reference.
   */
  profilePhotoRefs?: readonly string[];
  api?: Api<RawApi> | null;
}

export async function validateUserProfileVideo(
  input: ValidateUserProfileVideoInput,
): Promise<MediaValidationResult<ValidatedVideo>> {
  const result = await validateProfileVideo({ video: input.video });
  if (!result.ok) {
    await logMediaValidationRejection({
      userId: input.userId,
      mediaType: "video",
      reason: result.reason,
    });
  }
  return result;
}
