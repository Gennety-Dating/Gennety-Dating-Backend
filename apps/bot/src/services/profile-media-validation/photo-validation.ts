import {
  DUPLICATE_HASH_DISTANCE,
  FACE_SIMILARITY_THRESHOLD,
} from "@gennety/shared";
import {
  compareFaces,
  detectFaces,
  detectModerationLabels,
  type FaceDetectionResult,
  type FaceMatchResult,
} from "../face-match.js";
import {
  classifyDuplicate,
  fingerprintImage,
  hammingDistance64,
  type ImageFingerprint,
} from "./image-fingerprint.js";
import { combineModerationResults } from "./moderation-policy.js";
import { moderateImageWithOpenAI } from "./openai-moderation.js";
import {
  normalizeProfileImage,
  sniffImageMime,
} from "./image-normalization.js";
import type {
  DetectedFace,
  MediaValidationResult,
  ValidatedPhoto,
} from "./types.js";

// Deliberately lenient: a profile photo only needs to *contain a usable
// human face*, not a perfectly frontal studio shot. Rekognition drops detection
// confidence on angled / partially-turned faces, so a 0.90 floor was rejecting
// plenty of normal photos ("face clearly visible but bounced"). 0.75 keeps out
// non-faces / heavy occlusion while letting ordinary casual selfies through.
const MIN_FACE_CONFIDENCE = 0.75;
const MIN_FACE_AREA = 0.015;
const MIN_FACE_SHARPNESS = 0.15;

export interface ExistingPhotoForValidation {
  buffer: Buffer;
  fingerprint?: ImageFingerprint;
}

export interface PhotoValidationInput {
  candidate: Buffer;
  mime: string;
  existingPhotos?: readonly ExistingPhotoForValidation[];
  existingPhotoHashes?: readonly string[];
  identityReference?: Buffer | null;
}

export interface PhotoValidationOptions {
  identityVerifyThreshold?: number;
  identityReviewThreshold?: number;
  deps?: PhotoValidationDeps;
}

export interface PhotoValidationDeps {
  fingerprintImage: typeof fingerprintImage;
  normalizeImage: typeof normalizeProfileImage;
  moderateWithOpenAI: typeof moderateImageWithOpenAI;
  moderateWithAws: typeof detectModerationLabels;
  detectFaces: typeof detectFaces;
  compareFaces: typeof compareFaces;
}

const defaultDeps: PhotoValidationDeps = {
  fingerprintImage,
  normalizeImage: normalizeProfileImage,
  moderateWithOpenAI: moderateImageWithOpenAI,
  moderateWithAws: detectModerationLabels,
  detectFaces,
  compareFaces,
};

export async function validateProfilePhoto(
  input: PhotoValidationInput,
  options: PhotoValidationOptions = {},
): Promise<MediaValidationResult<ValidatedPhoto>> {
  const deps = options.deps ?? defaultDeps;
  if (
    input.candidate.byteLength === 0 ||
    !isSupportedImageMime(input.mime) ||
    !sniffImageMime(input.candidate)
  ) {
    return reject("invalid_media");
  }

  let candidateFingerprint: ImageFingerprint;
  let normalizedCandidate: Buffer;
  try {
    normalizedCandidate = await deps.normalizeImage(input.candidate);
    candidateFingerprint = await deps.fingerprintImage(input.candidate);
  } catch {
    return unavailable();
  }

  for (const existingHash of input.existingPhotoHashes ?? []) {
    if (!existingHash) continue;
    let distance: number;
    try {
      distance = hammingDistance64(candidateFingerprint.differenceHash, existingHash);
    } catch {
      return unavailable();
    }
    if (distance <= DUPLICATE_HASH_DISTANCE) {
      return reject("duplicate_near");
    }
  }

  for (const existing of input.existingPhotos ?? []) {
    let existingFingerprint: ImageFingerprint;
    try {
      existingFingerprint =
        existing.fingerprint ?? (await deps.fingerprintImage(existing.buffer));
    } catch {
      return unavailable();
    }

    const duplicate = classifyDuplicate(
      candidateFingerprint,
      existingFingerprint,
      {
        nearMax: DUPLICATE_HASH_DISTANCE,
        ambiguousMax: DUPLICATE_HASH_DISTANCE,
      },
    );
    if (duplicate.kind === "exact") {
      return reject("duplicate_exact");
    }
    if (duplicate.kind === "near") {
      return reject("duplicate_near");
    }
  }

  const moderation = combineModerationResults(
    await Promise.all([
      deps.moderateWithOpenAI(normalizedCandidate, "image/jpeg"),
      deps.moderateWithAws(normalizedCandidate),
    ]),
  );
  if (moderation.kind === "blocked" || moderation.kind === "review") {
    return reject("unsafe_content");
  }
  if (moderation.kind === "unavailable") return unavailable();

  const faceDetection: FaceDetectionResult = await deps.detectFaces(
    normalizedCandidate,
  );
  if (!faceDetection.ok) return unavailable();

  const usableFaces = faceDetection.faces.filter(isUsablePhotoFace);
  if (usableFaces.length === 0) return reject("no_face");

  const reference = input.identityReference ?? null;
  if (!reference) {
    return {
      ok: true,
      value: {
        fingerprint: candidateFingerprint,
        identitySimilarity: null,
      },
    };
  }

  let normalizedReference: Buffer;
  try {
    normalizedReference = await deps.normalizeImage(reference);
  } catch {
    return unavailable();
  }
  const identity: FaceMatchResult = await deps.compareFaces(
    normalizedReference,
    normalizedCandidate,
  );
  if (!identity.ok) return unavailable();
  if (!identity.faceFound) return reject("no_face");

  const verifyThreshold =
    options.identityVerifyThreshold ?? FACE_SIMILARITY_THRESHOLD;
  const reviewThreshold =
    options.identityReviewThreshold ?? FACE_SIMILARITY_THRESHOLD;
  if (identity.similarity < reviewThreshold) {
    return reject("identity_mismatch");
  }
  if (identity.similarity < verifyThreshold) {
    return reject("identity_uncertain", true);
  }

  return {
    ok: true,
    value: {
      fingerprint: candidateFingerprint,
      identitySimilarity: identity.similarity,
    },
  };
}

function isUsablePhotoFace(face: DetectedFace): boolean {
  const area = face.boundingBox
    ? face.boundingBox.width * face.boundingBox.height
    : 0;
  return (
    face.confidence >= MIN_FACE_CONFIDENCE &&
    area >= MIN_FACE_AREA &&
    (face.sharpness === null || face.sharpness >= MIN_FACE_SHARPNESS)
  );
}

function isSupportedImageMime(mime: string): boolean {
  return /^image\/(?:heic|heif|jpeg|png|webp)$/iu.test(mime.trim());
}

function reject(
  reason:
    | "invalid_media"
    | "duplicate_exact"
    | "duplicate_near"
    | "unsafe_content"
    | "no_face"
    | "multiple_faces_photo"
    | "identity_mismatch"
    | "identity_uncertain",
  retryable = false,
): MediaValidationResult<ValidatedPhoto> {
  return { ok: false, reason, retryable };
}

function unavailable(): MediaValidationResult<ValidatedPhoto> {
  return { ok: false, reason: "processing_unavailable", retryable: true };
}
