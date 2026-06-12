export type MediaValidationReason =
  | "invalid_media"
  | "duplicate_exact"
  | "duplicate_near"
  | "unsafe_content"
  | "no_face"
  | "multiple_faces_photo"
  | "identity_mismatch"
  | "identity_uncertain"
  | "video_owner_missing"
  | "video_owner_too_brief"
  | "video_mostly_other_person"
  | "video_identity_reference_missing"
  | "video_too_long"
  | "video_too_large_to_check"
  | "processing_unavailable";

export interface ValidatedPhoto {
  fingerprint: {
    sha256: string;
    differenceHash: string;
  };
  identitySimilarity: number | null;
}

export interface VideoFrame {
  buffer: Buffer;
  timestampSeconds: number;
}

export interface VideoOwnerEvidence {
  matchedFrameCount: number;
  matchedClusterCount: number;
  matchedTemporalThirds: number;
  hasHighQualityMatch: boolean;
}

export type MediaValidationResult<T = undefined> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: MediaValidationReason;
      retryable: boolean;
    };

export type ProviderError =
  | "api"
  | "invalid_response"
  | "not_configured"
  | "timeout";

export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DetectedFace {
  confidence: number;
  boundingBox: BoundingBox | null;
  brightness: number | null;
  sharpness: number | null;
  pitch: number | null;
  roll: number | null;
  yaw: number | null;
}

export interface ModerationSignal {
  provider: "aws" | "openai";
  category: string;
  score: number;
  severity: "block" | "review";
}

export type ModerationProviderResult =
  | {
      ok: true;
      signals: ModerationSignal[];
    }
  | {
      ok: false;
      error: ProviderError;
    };

export type CombinedModerationResult =
  | {
      kind: "safe";
      signals: ModerationSignal[];
    }
  | {
      kind: "blocked";
      signals: ModerationSignal[];
    }
  | {
      kind: "review";
      signals: ModerationSignal[];
    }
  | {
      kind: "unavailable";
      errors: ProviderError[];
    };
