import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { FACE_SIMILARITY_THRESHOLD } from "@gennety/shared";
import {
  downloadProfilePhoto,
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
import { resolveVerifiedIdentityReference } from "../verified-identity-reference.js";
import { alignPhotoHashes } from "./photo-state.js";

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
      verificationStatus: true,
      verifiedSelfiePath: true,
      personaInquiryId: true,
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
  const resolvedReference = await resolveVerifiedIdentityReference(user);
  if (resolvedReference.kind === "unavailable") return unavailable();
  const identityReference =
    resolvedReference.kind === "available" ? resolvedReference.buffer : null;

  const pendingCandidates = parsePendingPhotoCandidates(
    user.profile?.pendingPhotoCandidates ?? [],
  );
  const basePhotoRefs =
    input.existingPhotoRefs.length > 0
      ? [...input.existingPhotoRefs]
      : [...(user.profile?.photos ?? [])];
  const baseExistingHashes = alignPhotoHashes(
    basePhotoRefs,
    input.existingPhotoHashes ?? user.profile?.uploadedPhotoHashes ?? [],
  );
  const pendingHashes = pendingCandidates
    .map((candidate) => candidate.perceptualHash)
    .filter((hash): hash is string => Boolean(hash));
  const existingHashes = [
    ...baseExistingHashes.filter(Boolean),
    ...pendingHashes,
  ];
  const existingPhotos: ExistingPhotoForValidation[] = [];
  const refsForDuplicateFallback = [
    ...basePhotoRefs.filter((_, index) => !baseExistingHashes[index]),
    ...pendingCandidates
      .filter((candidate) => !candidate.perceptualHash)
      .map((candidate) => candidate.photoRef),
  ];
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
