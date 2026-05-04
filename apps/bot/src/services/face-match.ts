import {
  CompareFacesCommand,
  RekognitionClient,
  type CompareFacesCommandInput,
  type CompareFacesCommandOutput,
} from "@aws-sdk/client-rekognition";
import { env } from "../config.js";

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
  | { ok: true; similarity: number; faceFound: boolean }
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
    const best = matches.reduce((acc, m) => {
      const s = m.Similarity ?? 0;
      return s > acc ? s : acc;
    }, 0);

    return {
      ok: true,
      similarity: best / 100,
      faceFound: true,
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

/**
 * Reset the cached Rekognition client. Test-only — production code never
 * needs to invalidate the cache because the env values are read once at
 * boot.
 */
export function __resetClientForTests(): void {
  cachedClient = null;
}
