import {
  CompareFacesCommand,
  DetectFacesCommand,
  DetectModerationLabelsCommand,
  RekognitionClient,
  type CompareFacesCommandInput,
  type CompareFacesCommandOutput,
  type DetectFacesCommandOutput,
  type DetectModerationLabelsCommandOutput,
} from "@aws-sdk/client-rekognition";
import { env } from "../config.js";
import type {
  DetectedFace,
  ModerationProviderResult,
  ModerationSignal,
  ProviderError,
} from "./profile-media-validation/types.js";

/**
 * Face-match service used by the Persona verification pipeline.
 *
 * Compares a reference selfie (the one the user submitted to Persona during
 * the liveness flow — our ground truth) against a candidate profile photo,
 * and returns a normalised similarity score in `[0, 1]`. The decision logic
 * (verified / pending_review / rejected) lives in `verification-pipeline.ts`
 * — this module is intentionally policy-free.
 *
 * Provider toggle (`env.FACE_MATCH_PROVIDER`):
 *   - `rekognition` → real AWS Rekognition CompareFaces call.
 *   - `disabled`    → short-circuits to `{ ok: true, similarity: 1,
 *                      faceFound: true }`. Used in local dev / CI / when
 *                      AWS credentials are absent. Lets the rest of the
 *                      pipeline (DB writes, admin UI, retry logic) be
 *                      exercised without burning a real API call.
 *
 * Why CompareFaces (not embeddings + cosine): we don't run a face DB. The
 * stateless one-shot compare is the right primitive — no faces stored at
 * AWS, no embeddings to manage, no GDPR overhead beyond the ephemeral
 * in-memory call. If we ever need duplicate-account detection across the
 * whole user base, we'd switch to IndexFaces / SearchFaces instead.
 */

/**
 * Result of a single CompareFaces call.
 *
 * - `{ ok: true, similarity, faceFound }` — Rekognition completed.
 *   `similarity` is the strongest match in `[0, 1]` (Rekognition returns
 *   0..100; we divide by 100 for cosine-like ergonomics). `faceFound` is
 *   `false` when the candidate image had no detectable face — in that
 *   case `similarity` is `0` and the caller should treat it as a hard
 *   reject (a profile photo without a face can't be compared and isn't a
 *   valid profile photo anyway).
 * - `{ ok: false, error }` — infrastructure failure. Callers should
 *   move the user to `pending_review` rather than reject; we don't
 *   penalise users for our own outages.
 */
export type FaceMatchResult =
  | {
      ok: true;
      similarity: number;
      faceFound: boolean;
      matchedFace?: {
        confidence: number;
        boundingBox: DetectedFace["boundingBox"];
      };
    }
  | { ok: false; error: "no_source_face" | "api" | "timeout" | "not_configured" };

/**
 * Result returned when `FACE_MATCH_PROVIDER=disabled`. Exported so tests can
 * assert on the exact shape and so callers can rely on a stable contract
 * regardless of provider.
 */
export const DISABLED_PROVIDER_RESULT: FaceMatchResult = {
  ok: true,
  similarity: 1,
  faceFound: true,
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * AWS Rekognition `SimilarityThreshold` (0..100). We pass a low value so
 * Rekognition returns the best match even when it's poor — our verify /
 * review thresholds live in our own config and are applied downstream.
 */
const REKOGNITION_SIMILARITY_FLOOR = 0;

export interface CompareFacesOptions {
  /** Override the default 10s timeout. */
  timeoutMs?: number;
  /**
   * Inject a Rekognition client (or test double). Falls back to a singleton
   * built from `env.AWS_*` on first call. Tests pass an in-memory mock
   * that records command inputs and returns canned `CompareFacesCommandOutput`.
   */
  client?: Pick<RekognitionClient, "send">;
  /** Override the env-configured provider. Used in tests. */
  provider?: "rekognition" | "disabled";
}

export interface RekognitionImageOptions {
  timeoutMs?: number;
  client?: Pick<RekognitionClient, "send">;
  provider?: "rekognition" | "disabled";
  moderationMinConfidence?: number;
}

let cachedClient: RekognitionClient | null = null;

/**
 * Lazily build (and cache) a Rekognition client. We don't construct one at
 * module load time because:
 *   1. Production deploys may not have AWS creds yet during a partial roll.
 *   2. Tests stub out the SDK entirely and never need a real client.
 *
 * Returns `null` when credentials are missing — caller treats that as
 * `not_configured` and falls back to `pending_review` upstream.
 */
function getClient(): RekognitionClient | null {
  if (cachedClient) return cachedClient;
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  cachedClient = new RekognitionClient({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  return cachedClient;
}

/**
 * Compare two face images using AWS Rekognition CompareFaces.
 *
 * `reference` is the ground-truth image (Persona selfie). `candidate` is
 * the image being checked (profile photo). Both are raw image bytes —
 * the SDK accepts JPEG and PNG up to 5 MB; callers should down-scale
 * very large originals before passing them in.
 *
 * Never throws — branch on the discriminated `ok` field.
 */
export async function compareFaces(
  reference: Buffer,
  candidate: Buffer,
  options: CompareFacesOptions = {},
): Promise<FaceMatchResult> {
  const provider = options.provider ?? env.FACE_MATCH_PROVIDER;
  if (provider === "disabled") return DISABLED_PROVIDER_RESULT;

  const client = options.client ?? getClient();
  if (!client) return { ok: false, error: "not_configured" };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const input: CompareFacesCommandInput = {
    SourceImage: { Bytes: reference },
    TargetImage: { Bytes: candidate },
    SimilarityThreshold: REKOGNITION_SIMILARITY_FLOOR,
    QualityFilter: "AUTO",
  };

  try {
    const result = (await client.send(new CompareFacesCommand(input), {
      abortSignal: controller.signal,
    })) as CompareFacesCommandOutput;

    // No source-face = the selfie itself didn't contain a detectable face.
    // This is a Persona / pipeline bug, not a user fault. Surfacing it as a
    // distinct error lets the pipeline log + alert rather than silently
    // reject the user.
    const sourceFaces = result.SourceImageFace;
    if (!sourceFaces) return { ok: false, error: "no_source_face" };

    const matches = result.FaceMatches ?? [];
    if (matches.length === 0) {
      // Rekognition couldn't find any face in the candidate that resembles
      // the source above the (very low) floor. Could be:
      //   - candidate has no face (UnmatchedFaces also empty) → faceFound=false
      //   - candidate has a face but it's a different person → faceFound=true, sim=0
      const unmatched = result.UnmatchedFaces ?? [];
      return {
        ok: true,
        similarity: 0,
        faceFound: unmatched.length > 0,
      };
    }

    // CompareFaces sorts FaceMatches by similarity desc; take the strongest
    // pairing as the candidate's score. (Multiple faces in candidate ⇒ we
    // accept if ANY of them matches the source — matters for old group
    // photos where the user's face is one of several.)
    const best = matches.reduce((acc, match) => {
      const similarity = match.Similarity ?? 0;
      return similarity > (acc?.Similarity ?? -1) ? match : acc;
    }, matches[0]!);
    const bestBox = best.Face?.BoundingBox;

    return {
      ok: true,
      similarity: (best.Similarity ?? 0) / 100,
      faceFound: true,
      matchedFace: {
        confidence: normalizePercent(best.Face?.Confidence),
        boundingBox: bestBox
          ? {
              left: clampUnit(bestBox.Left),
              top: clampUnit(bestBox.Top),
              width: clampUnit(bestBox.Width),
              height: clampUnit(bestBox.Height),
            }
          : null,
      },
    };
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "AbortError" || name === "TimeoutError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "api" };
  } finally {
    clearTimeout(timer);
  }
}

export type FaceDetectionResult =
  | { ok: true; faces: DetectedFace[] }
  | { ok: false; error: ProviderError };

/**
 * Detect every face in an image and return only the geometry/quality fields
 * needed by profile-media validation. The provider-disabled branch is an
 * explicit unavailable result: unlike legacy face comparison, content
 * validation must not silently synthesize a successful production decision.
 */
export async function detectFaces(
  image: Buffer,
  options: RekognitionImageOptions = {},
): Promise<FaceDetectionResult> {
  const provider = options.provider ?? env.FACE_MATCH_PROVIDER;
  if (provider === "disabled") {
    return { ok: false, error: "not_configured" };
  }

  const client = options.client ?? getClient();
  if (!client) return { ok: false, error: "not_configured" };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const output = (await client.send(
      new DetectFacesCommand({
        Image: { Bytes: image },
        Attributes: ["DEFAULT", "FACE_OCCLUDED"],
      }),
      { abortSignal: controller.signal },
    )) as DetectFacesCommandOutput;

    return {
      ok: true,
      faces: (output.FaceDetails ?? []).map((face) => ({
        confidence: normalizePercent(face.Confidence),
        boundingBox: face.BoundingBox
          ? {
              left: clampUnit(face.BoundingBox.Left),
              top: clampUnit(face.BoundingBox.Top),
              width: clampUnit(face.BoundingBox.Width),
              height: clampUnit(face.BoundingBox.Height),
            }
          : null,
        brightness: normalizePercentOrNull(face.Quality?.Brightness),
        sharpness: normalizePercentOrNull(face.Quality?.Sharpness),
        pitch: finiteOrNull(face.Pose?.Pitch),
        roll: finiteOrNull(face.Pose?.Roll),
        yaw: finiteOrNull(face.Pose?.Yaw),
      })),
    };
  } catch (error) {
    return { ok: false, error: imageProviderError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run AWS image moderation and translate AWS's hierarchical labels into the
 * small provider-neutral policy surface used by photo/video validators.
 */
export async function detectModerationLabels(
  image: Buffer,
  options: RekognitionImageOptions = {},
): Promise<ModerationProviderResult> {
  const provider = options.provider ?? env.FACE_MATCH_PROVIDER;
  if (provider === "disabled") {
    return { ok: false, error: "not_configured" };
  }

  const client = options.client ?? getClient();
  if (!client) return { ok: false, error: "not_configured" };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const output = (await client.send(
      new DetectModerationLabelsCommand({
        Image: { Bytes: image },
        MinConfidence: options.moderationMinConfidence ?? 50,
      }),
      { abortSignal: controller.signal },
    )) as DetectModerationLabelsCommandOutput;

    const signals: ModerationSignal[] = (output.ModerationLabels ?? [])
      .filter((label) => typeof label.Name === "string" && label.Name.length > 0)
      .map((label) => {
        const category = label.Name!;
        return {
          provider: "aws" as const,
          category,
          score: normalizePercent(label.Confidence),
          severity: awsModerationSeverity(category, label.ParentName),
        };
      });
    return { ok: true, signals };
  } catch (error) {
    return { ok: false, error: imageProviderError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function awsModerationSeverity(
  category: string,
  parent: string | undefined,
): "block" | "review" {
  const normalized = `${parent ?? ""} ${category}`.toLowerCase();
  const hardBlockTerms = [
    "explicit nudity",
    "explicit sexual",
    "sexual activity",
    "graphic male nudity",
    "graphic female nudity",
    "illustrated explicit nudity",
    "sexualized child",
    "child sexual",
    "graphic violence",
    "self harm",
  ];
  return hardBlockTerms.some((term) => normalized.includes(term))
    ? "block"
    : "review";
}

function normalizePercent(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / 100));
}

function normalizePercentOrNull(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return normalizePercent(value);
}

function clampUnit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function imageProviderError(error: unknown): ProviderError {
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError" ? "timeout" : "api";
}

/**
 * Reset the cached Rekognition client. Test-only — production code never
 * needs to invalidate the cache because the env values are read once at
 * boot.
 */
export function __resetClientForTests(): void {
  cachedClient = null;
}
