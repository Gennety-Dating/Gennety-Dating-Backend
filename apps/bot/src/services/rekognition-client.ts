import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { env } from "../config.js";

/**
 * Shared, lazily-built AWS Rekognition client.
 *
 * Two independent consumers need it and must not each hold their own socket
 * pool / credential resolution:
 *   - `services/face-match.ts`     — CompareFaces / DetectFaces / moderation.
 *   - `services/face-liveness.ts`  — Face Liveness session create + results.
 *
 * Built lazily rather than at module load because a partially-rolled deploy
 * may not have AWS credentials yet, and tests stub the SDK entirely. Returns
 * `null` when credentials are missing — every caller treats that as
 * `not_configured` rather than throwing at import time.
 */

let cachedClient: RekognitionClient | null = null;

export function getRekognitionClient(): RekognitionClient | null {
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
 * Reset the cached client. Test-only — production reads the env values once
 * at boot and never needs to invalidate.
 */
export function __resetRekognitionClientForTests(): void {
  cachedClient = null;
}
