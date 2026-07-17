import type { Api } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { compareFaces } from "./face-match.js";
import { downloadTelegramFile } from "./storage.js";
import {
  resolveVerifiedIdentityReference,
  type VerifiedIdentityReferenceResult,
  type VerifiedIdentityUser,
} from "./verified-identity-reference.js";

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
 *   - Selfie expired (90-day retention scrubbed it) → re-fetch it from
 *     Persona for this comparison without retaining a new copy.
 *   - Rekognition / Supabase / Persona outage → fail closed and ask the
 *     caller to retry; never publish a verified user's unchecked photo.
 *   - Photo doesn't match → BLOCK. The whole point of the gate.
 *   - Photo has no detectable face → BLOCK. Already gated by
 *     `validate-face.ts` upstream, but defensive: we treat
 *     `faceFound=false` as score 0 so it triggers the same block path.
 */

export type GateOutcome =
  | { kind: "allowed"; score: number | null }
  | { kind: "blocked"; reason: "mismatch"; score: number }
  | { kind: "unavailable" };

export interface GateOptions {
  /** Override the verify threshold (tests). */
  thresholdVerify?: number;
  /** Override DB / storage / SDK deps for tests. */
  deps?: GateDeps;
}

export interface GateDeps {
  findUser: (userId: string) => Promise<{
    verificationStatus: string;
    verifiedSelfiePath: string | null;
    personaInquiryId: string | null;
  } | null>;
  resolveIdentityReference: (
    user: VerifiedIdentityUser,
  ) => Promise<VerifiedIdentityReferenceResult>;
  compareFaces: typeof compareFaces;
}

const LOG_PREFIX = "[face-match-gate]";

/**
 * Run the face-match gate against a candidate photo buffer. Returns
 * `{ kind: 'allowed', score }` to let the caller proceed (and persist the
 * score alongside the photo), or `{ kind: 'blocked', reason: 'mismatch' }`
 * to surface a 422 to the user.
 *
 * `score` is null on the allow path only when the user has not completed
 * verification yet. Infrastructure failures return `unavailable`.
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
        select: {
          verificationStatus: true,
          verifiedSelfiePath: true,
          personaInquiryId: true,
        },
      }),
    resolveIdentityReference: resolveVerifiedIdentityReference,
    compareFaces,
  };
  const thresholdVerify = options.thresholdVerify ?? env.FACE_MATCH_THRESHOLD_VERIFY;

  const user = await deps.findUser(userId);
  if (!user) return { kind: "unavailable" };

  const reference = await deps.resolveIdentityReference(user);
  if (reference.kind === "not_required") {
    return { kind: "allowed", score: null };
  }
  if (reference.kind === "unavailable") {
    console.warn(`${LOG_PREFIX} verified selfie unavailable, failing closed`, {
      userId,
    });
    return { kind: "unavailable" };
  }

  const result = await deps.compareFaces(reference.buffer, photoBuffer);
  if (!result.ok) {
    console.warn(`${LOG_PREFIX} compareFaces error, failing closed`, {
      userId,
      error: result.error,
    });
    return { kind: "unavailable" };
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
 * any failure. Callers must reject the upload when bytes are unavailable.
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
