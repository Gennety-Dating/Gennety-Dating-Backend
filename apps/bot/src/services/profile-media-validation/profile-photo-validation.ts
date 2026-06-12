import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import {
  downloadProfilePhoto,
  downloadSelfie,
  downloadTelegramFile,
} from "../storage.js";
import {
  validateProfilePhoto,
  type ExistingPhotoForValidation,
} from "./photo-validation.js";
import type {
  MediaValidationResult,
  ValidatedPhoto,
} from "./types.js";

export interface ValidateUserProfilePhotoInput {
  userId: string;
  candidate: Buffer;
  mime: string;
  existingPhotoRefs: readonly string[];
  api?: Api<RawApi> | null;
}

export async function validateUserProfilePhoto(
  input: ValidateUserProfilePhotoInput,
): Promise<MediaValidationResult<ValidatedPhoto>> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { verifiedSelfiePath: true },
  });
  if (!user) return unavailable();

  let identityReference: Buffer | null = null;
  if (user.verifiedSelfiePath) {
    identityReference = await downloadSelfie(user.verifiedSelfiePath);
    if (!identityReference) return unavailable();
  }

  const existingPhotos: ExistingPhotoForValidation[] = [];
  for (const ref of input.existingPhotoRefs) {
    const buffer = await downloadExistingPhoto(ref, input.api);
    if (!buffer) return unavailable();
    existingPhotos.push({ buffer });
  }

  return validateProfilePhoto(
    {
      candidate: input.candidate,
      mime: input.mime,
      existingPhotos,
      identityReference,
    },
    {
      identityVerifyThreshold: env.FACE_MATCH_THRESHOLD_VERIFY,
      identityReviewThreshold: env.FACE_MATCH_THRESHOLD_REVIEW,
    },
  );
}

async function downloadExistingPhoto(
  ref: string,
  api: Api<RawApi> | null | undefined,
): Promise<Buffer | null> {
  if (ref.includes("/")) return downloadProfilePhoto(ref);
  if (!api) return null;
  return downloadTelegramFile(api, ref);
}

function unavailable(): MediaValidationResult<ValidatedPhoto> {
  return { ok: false, reason: "processing_unavailable", retryable: true };
}
