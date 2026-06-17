import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { FACE_SIMILARITY_THRESHOLD } from "@gennety/shared";
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
import { logMediaValidationRejection } from "./rejection-log.js";

export interface ValidateUserProfilePhotoInput {
  userId: string;
  candidate: Buffer;
  mime: string;
  existingPhotoRefs: readonly string[];
  existingPhotoHashes?: readonly string[];
  api?: Api<RawApi> | null;
}

export async function validateUserProfilePhoto(
  input: ValidateUserProfilePhotoInput,
): Promise<MediaValidationResult<ValidatedPhoto>> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      verifiedSelfiePath: true,
      profile: {
        select: {
          photos: true,
          uploadedPhotoHashes: true,
        },
      },
    },
  });
  if (!user) return unavailable();

  let identityReference: Buffer | null = null;
  if (user.verifiedSelfiePath) {
    identityReference = await downloadSelfie(user.verifiedSelfiePath);
    if (!identityReference) return unavailable();
  }

  const existingHashes =
    input.existingPhotoHashes ??
    user.profile?.uploadedPhotoHashes ??
    [];
  const existingPhotos: ExistingPhotoForValidation[] = [];
  const needsPhotoFallbackHashes = existingHashes.length === 0;
  const refsForDuplicateFallback = needsPhotoFallbackHashes
    ? input.existingPhotoRefs
    : [];
  for (const ref of refsForDuplicateFallback) {
    const buffer = await downloadExistingPhoto(ref, input.api);
    if (!buffer) return unavailable();
    existingPhotos.push({ buffer });
  }

  const referencePhotoRef =
    !identityReference && input.existingPhotoRefs.length === 0
      ? user.profile?.photos[0]
      : input.existingPhotoRefs[0];
  if (!identityReference && referencePhotoRef) {
    identityReference = await downloadExistingPhoto(referencePhotoRef, input.api);
    if (!identityReference) return unavailable();
  }

  const result = await validateProfilePhoto(
    {
      candidate: input.candidate,
      mime: input.mime,
      existingPhotos,
      existingPhotoHashes: existingHashes,
      identityReference,
    },
    {
      identityVerifyThreshold: FACE_SIMILARITY_THRESHOLD,
      identityReviewThreshold: FACE_SIMILARITY_THRESHOLD,
    },
  );
  if (!result.ok) {
    await logMediaValidationRejection({
      userId: input.userId,
      mediaType: "photo",
      reason: result.reason,
    });
  }
  return result;
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
