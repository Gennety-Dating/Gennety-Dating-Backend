import {
  compareFaces,
  detectFaces,
  detectModerationLabels,
  type FaceDetectionResult,
  type FaceMatchResult,
} from "../face-match.js";
import { classifyDuplicatePairWithOpenAI } from "./duplicate-classifier.js";
import {
  classifyDuplicate,
  fingerprintImage,
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

const IDENTITY_VERIFY_THRESHOLD = 0.85;
const IDENTITY_REVIEW_THRESHOLD = 0.75;
const MIN_FACE_CONFIDENCE = 0.9;
const MIN_FACE_AREA = 0.015;
const MIN_FACE_SHARPNESS = 0.15;
const MIN_SECONDARY_FACE_AREA = 0.003;

export interface ExistingPhotoForValidation {
  buffer: Buffer;
  fingerprint?: ImageFingerprint;
}

export interface PhotoValidationInput {
  candidate: Buffer;
  mime: string;
  existingPhotos?: readonly ExistingPhotoForValidation[];
  identityReference?: Buffer | null;
}

export interface PhotoValidationOptions {
  identityVerifyThreshold?: number;
  identityReviewThreshold?: number;
  deps?: PhotoValidationDeps;
}

export interface PhotoValidationDeps {
  fingerprintImage: typeof fingerprintImage;
  classifyDuplicatePair: typeof classifyDuplicatePairWithOpenAI;
  normalizeImage: typeof normalizeProfileImage;
  moderateWithOpenAI: typeof moderateImageWithOpenAI;
  moderateWithAws: typeof detectModerationLabels;
  detectFaces: typeof detectFaces;
  compareFaces: typeof compareFaces;
}

const defaultDeps: PhotoValidationDeps = {
  fingerprintImage,
  classifyDuplicatePair: classifyDuplicatePairWithOpenAI,
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
    );
    if (duplicate.kind === "exact") {
      return reject("duplicate_exact");
    }
    if (duplicate.kind === "near") {
      return reject("duplicate_near");
    }
    if (duplicate.kind === "ambiguous") {
      let normalizedExisting: Buffer;
      try {
        normalizedExisting = await deps.normalizeImage(existing.buffer);
      } catch {
        return unavailable();
      }
      const classified = await deps.classifyDuplicatePair(
        normalizedExisting,
        normalizedCandidate,
      );
      if (!classified.ok) return unavailable();
      if (classified.duplicate) return reject("duplicate_near");
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

  const credibleFaces = faceDetection.faces.filter(isCrediblePhotoFace);
  if (credibleFaces.length > 1) return reject("multiple_faces_photo");

  const usableFaces = credibleFaces.filter(isUsablePhotoFace);
  if (usableFaces.length === 0) return reject("no_face");

  const reference =
    input.identityReference ?? input.existingPhotos?.[0]?.buffer ?? null;
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
    options.identityVerifyThreshold ?? IDENTITY_VERIFY_THRESHOLD;
  const reviewThreshold =
    options.identityReviewThreshold ?? IDENTITY_REVIEW_THRESHOLD;
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

function isCrediblePhotoFace(face: DetectedFace): boolean {
  const area = face.boundingBox
    ? face.boundingBox.width * face.boundingBox.height
    : 0;
  return face.confidence >= 0.85 && area >= MIN_SECONDARY_FACE_AREA;
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
