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
import {
  parsePendingPhotoCandidates,
} from "./identity-consensus.js";
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
          pendingPhotoCandidates: true,
        },
      },
    },
  });
  if (!user) return unavailable();

  // Identity is enforced ONLY against the Persona-captured selfie (our ground
  // truth). Before verification we deliberately do NOT compare an uploaded
  // photo to any self-uploaded "anchor": cross-photo CompareFaces was
  // brittle (same person scoring below threshold on a different angle / light)
  // and stranded honest users with zero accepted photos. Persona verification
  // is the real identity gate; an unverified user already carries the Elo
  // penalty and is re-checked against the selfie on every later photo edit.
  let identityReference: Buffer | null = null;
  if (user.verifiedSelfiePath) {
    identityReference = await downloadSelfie(user.verifiedSelfiePath);
    if (!identityReference) return unavailable();
  }

  const pendingCandidates = parsePendingPhotoCandidates(
    user.profile?.pendingPhotoCandidates ?? [],
  );
  const baseExistingHashes =
    input.existingPhotoHashes ?? user.profile?.uploadedPhotoHashes ?? [];
  const pendingHashes = pendingCandidates
    .map((candidate) => candidate.perceptualHash)
    .filter((hash): hash is string => Boolean(hash));
  const existingHashes = [...baseExistingHashes, ...pendingHashes];
  const existingPhotos: ExistingPhotoForValidation[] = [];
  const needsPhotoFallbackHashes = existingHashes.length === 0;
  const refsForDuplicateFallback = needsPhotoFallbackHashes
    ? [
        ...(input.existingPhotoRefs.length > 0
          ? input.existingPhotoRefs
          : (user.profile?.photos ?? [])),
        ...pendingCandidates.map((candidate) => candidate.photoRef),
      ]
    : [];
  for (const ref of refsForDuplicateFallback) {
    const buffer = await downloadExistingPhoto(ref, input.api);
    if (!buffer) return unavailable();
    existingPhotos.push({ buffer });
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
