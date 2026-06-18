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
  const uploadedPhotoHashes = [...args.uploadedPhotoHashes].filter(Boolean);
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
