import { prisma } from "@gennety/db";
import { downloadSelfie } from "./storage.js";

/**
 * Provider-neutral source of the **reference selfie** — the ground-truth face
 * every profile photo is matched against.
 *
 * Why this exists as its own seam: under Persona the pipeline re-fetched the
 * selfie from the provider on *every* run, including reruns days later. AWS
 * Face Liveness cannot do that — a session and its reference image expire 3
 * minutes after the session is created. So the selfie has exactly two origins
 * now, and the pipeline must not care which one it got:
 *
 *   1. **A fresh capture.** The liveness route holds the bytes AWS just
 *      returned and hands them straight in. The pipeline uploads them to the
 *      selfies bucket and records the path.
 *   2. **Our own storage.** Every rerun (a photo edit, an admin recheck) reads
 *      `User.verifiedSelfiePath`. These bytes are already persisted, so the
 *      pipeline must NOT re-upload them — hence `storedPath`.
 *
 * There is deliberately no third origin. When storage has nothing (the 90-day
 * GDPR scrub ran), the honest answer is `reference_expired`: the user runs one
 * more liveness check rather than us silently keeping biometric data longer
 * than we said we would.
 */

export interface ReferenceSelfie {
  buffer: Buffer;
  mime: string;
  /**
   * Set only when the bytes came from our own selfies bucket. Its presence is
   * the pipeline's signal to keep the existing `verifiedSelfiePath` instead of
   * writing a duplicate object on every photo edit.
   */
  storedPath?: string;
}

export type ReferenceSelfieError =
  /** No stored selfie and no fresh capture — the user must re-run liveness. */
  | "reference_expired"
  /** Storage is configured but the object didn't come back. Transient. */
  | "download_failed";

export type ReferenceSelfieResult =
  | { ok: true; selfie: ReferenceSelfie }
  | { ok: false; error: ReferenceSelfieError };

/** A selfie the liveness provider just handed us, not yet persisted. */
export interface CapturedSelfie {
  buffer: Buffer;
  mime: string;
}

/**
 * Source for a fresh liveness capture. Always succeeds — the bytes are already
 * in memory.
 */
export function capturedSelfieSource(
  captured: CapturedSelfie,
): () => Promise<ReferenceSelfieResult> {
  return async () => ({ ok: true, selfie: { ...captured } });
}

/**
 * Source for a rerun: read the selfie this user was verified against out of the
 * selfies bucket.
 */
export function storedSelfieSource(
  userId: string,
  deps: { download?: typeof downloadSelfie } = {},
): () => Promise<ReferenceSelfieResult> {
  const download = deps.download ?? downloadSelfie;
  return async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { verifiedSelfiePath: true },
    });
    if (!user?.verifiedSelfiePath) {
      return { ok: false, error: "reference_expired" };
    }
    const buffer = await download(user.verifiedSelfiePath);
    if (!buffer) return { ok: false, error: "download_failed" };
    return {
      ok: true,
      selfie: {
        buffer,
        // Everything we store in this bucket is written as JPEG by
        // `uploadSelfie`; Rekognition sniffs the bytes anyway.
        mime: "image/jpeg",
        storedPath: user.verifiedSelfiePath,
      },
    };
  };
}
