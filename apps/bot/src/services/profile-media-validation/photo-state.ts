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

/**
 * A new order for a profile's photos (`order[i]` = the old index of the photo
 * that lands at position `i`) with everything that is positional against
 * `photos[]` moved alongside: the static items of `profileMedia` fill the same
 * static slots in the new order (a video keeps its place among them), and each
 * hash and face score follows its photo. Scores of an unaligned legacy array
 * are dropped, as a delete drops them.
 *
 * `null` when `order` is not a permutation of the current indexes — the
 * caller's view of the photos is stale.
 */
export function reorderProfilePhotos<M extends { type: string }>(args: {
  photos: readonly string[];
  media: readonly M[];
  photoFaceScores: readonly number[];
  uploadedPhotoHashes: readonly string[];
  order: readonly number[];
}): {
  photos: string[];
  media: M[];
  photoFaceScores: number[];
  uploadedPhotoHashes: string[];
} | null {
  const { photos, order } = args;
  if (order.length !== photos.length) return null;
  const seen = new Set<number>();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= photos.length || seen.has(index)) {
      return null;
    }
    seen.add(index);
  }
  const statics = args.media.filter((item) => item.type !== "video");
  if (statics.length !== photos.length) return null;

  const reorderedStatics = order.map((index) => statics[index]!);
  let slot = 0;
  const media = args.media.map((item) =>
    item.type === "video" ? item : reorderedStatics[slot++]!,
  );
  const hashes = alignPhotoHashes(photos, args.uploadedPhotoHashes);
  return {
    photos: order.map((index) => photos[index]!),
    media,
    photoFaceScores:
      args.photoFaceScores.length === photos.length
        ? order.map((index) => args.photoFaceScores[index]!)
        : [],
    uploadedPhotoHashes: order.map((index) => hashes[index]!),
  };
}
