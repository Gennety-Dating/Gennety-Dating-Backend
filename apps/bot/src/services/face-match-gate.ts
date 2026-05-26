import type { Api } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { compareFaces } from "./face-match.js";
import { downloadSelfie, downloadTelegramFile } from "./storage.js";

/**
 * Photo-upload gate: enforces that any photo a verified user adds to their
 * profile actually depicts the same person as the verified Persona selfie.
 *
 * Without this gate, the verification pipeline (Step 3) is a one-shot
 * check: a user could verify with an honest selfie, then swap in someone
 * else's photos and dodge the matcher. This module re-checks every new
 * photo at upload time and either allows it (with the score recorded) or
 * blocks the upload outright.
 *
 * Failure-mode policy:
 *   - User not verified → allow (no reference selfie to compare against).
 *   - Selfie expired (90-day retention scrubbed it) → allow + log; we'll
 *     re-check the whole profile during the next manual admin rerun.
 *   - Rekognition / Supabase outage → ALLOW (fail-open). Reason: a
 *     transient outage shouldn't block legitimate uploads, and the
 *     stored photo is still available for re-validation when the admin
 *     reruns. We log loudly so a sustained outage is visible in Grafana.
 *   - Photo doesn't match → BLOCK. The whole point of the gate.
 *   - Photo has no detectable face → BLOCK. Already gated by
 *     `validate-face.ts` upstream, but defensive: we treat
 *     `faceFound=false` as score 0 so it triggers the same block path.
 */

export type GateOutcome =
  | { kind: "allowed"; score: number | null }
  | { kind: "blocked"; reason: "mismatch"; score: number };

export interface GateOptions {
  /** Override the verify threshold (tests). */
  thresholdVerify?: number;
  /** Override DB / storage / SDK deps for tests. */
  deps?: GateDeps;
}

export interface GateDeps {
  findUser: (userId: string) => Promise<{ verifiedSelfiePath: string | null } | null>;
  downloadSelfie: typeof downloadSelfie;
  compareFaces: typeof compareFaces;
}

const LOG_PREFIX = "[face-match-gate]";

/**
 * Run the face-match gate against a candidate photo buffer. Returns
 * `{ kind: 'allowed', score }` to let the caller proceed (and persist the
 * score alongside the photo), or `{ kind: 'blocked', reason: 'mismatch' }`
 * to surface a 422 to the user.
 *
 * `score` is null on the allow path when the gate didn't actually run —
 * either because the user has no verified selfie yet, or because of an
 * infrastructure failure we chose to fail-open through. Callers should
 * persist `null` (or skip the score append) in that case.
 */
export async function gateProfilePhoto(
  userId: string,
  photoBuffer: Buffer,
  options: GateOptions = {},
): Promise<GateOutcome> {
  const deps: GateDeps = options.deps ?? {
    findUser: async (id) =>
      prisma.user.findUnique({
        where: { id },
        select: { verifiedSelfiePath: true },
      }),
    downloadSelfie,
    compareFaces,
  };
  const thresholdVerify = options.thresholdVerify ?? env.FACE_MATCH_THRESHOLD_VERIFY;

  const user = await deps.findUser(userId);
  if (!user || !user.verifiedSelfiePath) {
    // User isn't verified yet — no reference selfie. Photo upload is
    // governed by the existing single-face-vision gate only. The score
    // for this photo will be filled in later when the verification
    // pipeline runs (it scans the full photo array).
    return { kind: "allowed", score: null };
  }

  const selfieBuffer = await deps.downloadSelfie(user.verifiedSelfiePath);
  if (!selfieBuffer) {
    console.warn(`${LOG_PREFIX} verified selfie unavailable, failing open`, {
      userId,
      path: user.verifiedSelfiePath,
    });
    return { kind: "allowed", score: null };
  }

  const result = await deps.compareFaces(selfieBuffer, photoBuffer);
  if (!result.ok) {
    console.warn(`${LOG_PREFIX} compareFaces error, failing open`, {
      userId,
      error: result.error,
    });
    return { kind: "allowed", score: null };
  }

  // `faceFound=false` already implies similarity=0 in face-match.ts; we
  // collapse the two cases here so a face-less photo trips the same
  // mismatch branch as a different-person photo.
  const score = result.faceFound ? result.similarity : 0;

  if (score < thresholdVerify) {
    return { kind: "blocked", reason: "mismatch", score };
  }

  return { kind: "allowed", score };
}

/**
 * Download a Telegram photo by `file_id` and return its bytes. Used by the
 * bot's edit-photos flow to feed the face-match gate, since photos there
 * are stored as `file_id` strings (not Supabase paths). Returns `null` on
 * any failure — the bot caller treats that as "skip the gate" (fail-open),
 * matching the storage-side gate's behavior.
 *
 * Thin wrapper over `storage.downloadTelegramFile` so the actual fetch
 * lives in exactly one place — historically this had its own duplicate
 * implementation that drifted from the verification-pipeline path.
 */
export async function fetchTelegramFileBuffer(
  api: Api,
  fileId: string,
): Promise<Buffer | null> {
  return downloadTelegramFile(api, fileId);
}
