import { Prisma } from "@gennety/db";
import { PROFILE_MEDIA_VALIDATION_VERSION } from "@gennety/shared";

export interface ReferenceFaceAnchor {
  kind: "reference_photo";
  provider: "rekognition_compare_faces";
  version: number;
  photoRef: string;
  perceptualHash?: string;
  createdAt: string;
}

/** Empty string is the persisted sentinel for a photo with no available hash. */
export const MISSING_PHOTO_HASH = "";

/**
 * Keep hashes strictly positional with `photos`. A legacy array whose length
 * differs is ambiguous (old writers omitted missing hashes), so it is safer to
 * discard those associations than attach a hash to the wrong photo.
 */
export function alignPhotoHashes(
  photos: readonly string[],
  uploadedPhotoHashes: readonly string[],
): string[] {
  if (uploadedPhotoHashes.length !== photos.length) {
    return photos.map(() => MISSING_PHOTO_HASH);
  }
  return photos.map((_, index) => uploadedPhotoHashes[index] ?? MISSING_PHOTO_HASH);
}

export function appendAlignedPhotoHash(
  photos: readonly string[],
  uploadedPhotoHashes: readonly string[],
  hash: string | null | undefined,
): string[] {
  return [
    ...alignPhotoHashes(photos, uploadedPhotoHashes),
    hash || MISSING_PHOTO_HASH,
  ];
}

export function removeAlignedPhotoHash(
  photos: readonly string[],
  uploadedPhotoHashes: readonly string[],
  index: number,
): string[] {
  const aligned = alignPhotoHashes(photos, uploadedPhotoHashes);
  return [...aligned.slice(0, index), ...aligned.slice(index + 1)];
}

export function buildReferenceFaceEmbedding(
  photoRef: string | undefined,
  perceptualHash: string | undefined,
  now: Date = new Date(),
): Prisma.InputJsonObject | undefined {
  if (!photoRef) return undefined;
  return {
    kind: "reference_photo",
    provider: "rekognition_compare_faces",
    version: PROFILE_MEDIA_VALIDATION_VERSION,
    photoRef,
    ...(perceptualHash ? { perceptualHash } : {}),
    createdAt: now.toISOString(),
  };
}

export function referencePhotoRefFromAnchor(
  value: Prisma.JsonValue | null | undefined,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const photoRef = (value as Record<string, unknown>).photoRef;
  return typeof photoRef === "string" && photoRef.length > 0 ? photoRef : null;
}

export function photoUploadStatePatch(args: {
  photos: readonly string[];
  uploadedPhotoHashes: readonly string[];
  referenceFaceEmbedding?: Prisma.JsonValue | null;
  refreshReference?: boolean;
  confirmReference?: boolean;
  referencePhotoRef?: string;
  referencePerceptualHash?: string;
  clearReference?: boolean;
  skipReferenceCreation?: boolean;
}): {
  uploadedPhotoHashes: string[];
  acceptedPhotoCount: number;
  referenceFaceEmbedding?: Prisma.InputJsonValue | typeof Prisma.DbNull;
} {
  const uploadedPhotoHashes = alignPhotoHashes(
    args.photos,
    args.uploadedPhotoHashes,
  );
  if (args.clearReference) {
    return {
      uploadedPhotoHashes,
      acceptedPhotoCount: args.photos.length,
      referenceFaceEmbedding: Prisma.DbNull,
    };
  }

  const shouldRefreshReference =
    args.refreshReference ||
    args.confirmReference ||
    (!args.referenceFaceEmbedding && !args.skipReferenceCreation);
  const referencePhotoRef = args.referencePhotoRef ?? args.photos[0];
  const referenceHash =
    args.referencePerceptualHash ??
    (referencePhotoRef
      ? uploadedPhotoHashes[args.photos.indexOf(referencePhotoRef)]
      : undefined) ??
    uploadedPhotoHashes[0];
  const nextReference = shouldRefreshReference
    ? buildReferenceFaceEmbedding(referencePhotoRef, referenceHash)
    : args.referenceFaceEmbedding;

  return {
    uploadedPhotoHashes,
    acceptedPhotoCount: args.photos.length,
    ...(nextReference ? { referenceFaceEmbedding: nextReference } : {}),
  };
}
