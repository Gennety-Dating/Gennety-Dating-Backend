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
// human face*, not a perfectly frontal studio shot. We gate on just two things:
//   - confidence ≥ 0.55 — Rekognition is reasonably sure it's a face. The floor
//     was lowered from 0.75 after a calibration run found a real profile photo
//     detected at 0.61 being bounced as `no_face` (the founder's "stuck at
//     1/2 photos" complaint); 0.75 still over-rejected angled / lower-light
//     shots, so identity is left to Persona, not this presence floor.
//   - area ≥ 0.8% — the face is a real part of the frame, not a speck. Lowered
//     from 1.5% so full-body / further-back shots are not bounced.
// We intentionally do NOT gate on Rekognition's `Sharpness` quality metric or
// its noisy `FaceOccluded` signal (the calibration run saw FaceOccluded fire at
// 0.93 on a perfectly clear face): both read false on many usable phone photos
// and gating on them silently rejected legitimate users. Softness only hurts the
// uploader's own appeal; Persona verification remains the identity gate.
const MIN_FACE_CONFIDENCE = 0.55;
const MIN_FACE_AREA = 0.008;

// The face must also be *recognizable*. We reject only two clearly-detectable
// obstructions, tuned against a calibration run so ordinary photos pass:
//   - sunglasses ≥ 0.90 — dark glasses hiding the eyes (clear prescription
//     glasses report `Sunglasses=false`, so they pass);
//   - a face covering ≥ 0.99 — a mask / scarf over the face. The floor is high
//     on purpose: AWS `FaceOccluded` fired falsely up to 0.93 on perfectly
//     clear faces in calibration, while real masks/coverings read 1.00, so 0.99
//     catches the real cases without bouncing clear photos.
// Everything else about pose / lighting / sharpness is left lenient — extreme
// "turned away / too dark / blurred / face cropped out" shots already fail the
// face-presence gate above (Rekognition returns no face or a sub-floor one).
const MIN_SUNGLASSES_CONFIDENCE = 0.9;
const MIN_FACE_OCCLUSION_CONFIDENCE = 0.99;

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

  // Check obstruction only on the most prominent (largest) face — the subject
  // of a selfie — so a background bystander's sunglasses never bounce a photo.
  const primaryFace = usableFaces.reduce((largest, face) =>
    faceArea(face) > faceArea(largest) ? face : largest,
  );
  if (isFaceObscured(primaryFace)) return reject("face_obscured");

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

function faceArea(face: DetectedFace): number {
  return face.boundingBox
    ? face.boundingBox.width * face.boundingBox.height
    : 0;
}

function isUsablePhotoFace(face: DetectedFace): boolean {
  return face.confidence >= MIN_FACE_CONFIDENCE && faceArea(face) >= MIN_FACE_AREA;
}

function isFaceObscured(face: DetectedFace): boolean {
  if (
    face.sunglasses?.value &&
    face.sunglasses.confidence >= MIN_SUNGLASSES_CONFIDENCE
  ) {
    return true;
  }
  if (
    face.occluded?.value &&
    face.occluded.confidence >= MIN_FACE_OCCLUSION_CONFIDENCE
  ) {
    return true;
  }
  return false;
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
    | "face_obscured"
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
