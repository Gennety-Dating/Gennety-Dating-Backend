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

export function photoUploadStatePatch(args: {
  photos: readonly string[];
  uploadedPhotoHashes: readonly string[];
  referenceFaceEmbedding?: Prisma.JsonValue | null;
  refreshReference?: boolean;
}): {
  uploadedPhotoHashes: string[];
  acceptedPhotoCount: number;
  referenceFaceEmbedding?: Prisma.InputJsonValue;
} {
  const uploadedPhotoHashes = [...args.uploadedPhotoHashes].filter(Boolean);
  const shouldRefreshReference =
    args.refreshReference || !args.referenceFaceEmbedding;
  const nextReference = shouldRefreshReference
    ? buildReferenceFaceEmbedding(args.photos[0], uploadedPhotoHashes[0])
    : args.referenceFaceEmbedding;

  return {
    uploadedPhotoHashes,
    acceptedPhotoCount: args.photos.length,
    ...(nextReference ? { referenceFaceEmbedding: nextReference } : {}),
  };
}
