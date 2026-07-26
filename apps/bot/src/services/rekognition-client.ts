import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { env } from "../config.js";

/**
 * Shared, lazily-built AWS Rekognition clients, cached per region.
 *
 * Two independent consumers need Rekognition and must not each hold their own
 * socket pool / credential resolution:
 *   - `services/face-match.ts`     — CompareFaces / DetectFaces / moderation,
 *                                    in `AWS_REGION` (eu-central-1).
 *   - `services/face-liveness.ts`  — Face Liveness session create + results,
 *                                    in `FACE_LIVENESS_REGION` (eu-west-1).
 *
 * Why the cache is keyed by region: **Face Liveness is not available in every
 * region that serves the rest of Rekognition.** Our `AWS_REGION` is
 * eu-central-1 (Frankfurt), where `CreateFaceLivenessSession` fails — and it
 * fails with a message-less `AccessDeniedException`, which reads exactly like
 * an IAM problem and cost us a debugging session. eu-west-1 (Ireland) is the
 * only EU region that serves it, and is also where our Supabase project lives,
 * so the reference selfie never leaves that region anyway.
 *
 * Built lazily rather than at module load because a partially-rolled deploy
 * may not have AWS credentials yet, and tests stub the SDK entirely. Returns
 * `null` when credentials are missing — every caller treats that as
 * `not_configured` rather than throwing at import time.
 */

const clients = new Map<string, RekognitionClient>();

/**
 * @param region Defaults to `AWS_REGION`. Pass `FACE_LIVENESS_REGION`
 *               explicitly for liveness calls — see the note above.
 */
export function getRekognitionClient(
  region: string = env.AWS_REGION,
): RekognitionClient | null {
  const cached = clients.get(region);
  if (cached) return cached;
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  const client = new RekognitionClient({
    region,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  clients.set(region, client);
  return client;
}

/**
 * Reset the cached clients. Test-only — production reads the env values once
 * at boot and never needs to invalidate.
 */
export function __resetRekognitionClientForTests(): void {
  clients.clear();
}
