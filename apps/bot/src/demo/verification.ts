import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";

import { runFaceMatchVerificationDefault } from "../services/verification-pipeline.js";
import type { OutcomeGate } from "../services/outcome-gate.js";

/**
 * Demo mode's identity check: real on screen, decided in advance.
 *
 * The visitor runs the genuine Face Liveness Mini App — same camera, same
 * on-screen instructions, same session minted against AWS — because that
 * experience is a big part of what a demo is for. What the demo skips is the
 * *verdict*: no session result is read and no faces are compared, so a visitor
 * who uploaded three pictures of a cat is still let through.
 *
 * Everything after the verdict is the untouched production pipeline: the same
 * activation, the same outcome DM, the same menu and pinned banner, the same
 * Elo seed. Only the evidence is stubbed, and only these four deps carry it —
 * which is why this replaces them rather than re-implementing the pipeline.
 *
 * A note on why the stubs return data rather than skipping the calls: the
 * pipeline decides from `compareFaces` scores, so a stub that always answers
 * "0.99, face found" produces `verified` through the real decision code — the
 * quorum rule, the photo-drop rule and the activation gate all run for real and
 * agree. Nothing here special-cases the outcome.
 */

/**
 * A 1×1 white JPEG. Never displayed, never uploaded, never compared — it exists
 * only because `fetchReferenceSelfie` is typed to return bytes.
 */
const STUB_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

/**
 * Fixed path stamped as `verifiedSelfiePath`. Deliberately not a real storage
 * object: uploading a stub selfie would put junk in a bucket for no benefit,
 * and demo accounts never take the rerun path that reads it back.
 */
const STUB_SELFIE_PATH = "demo/verified-selfie-stub.jpg";

/**
 * Run the production verification pipeline with the identity evidence stubbed.
 *
 * Called only from `completeLivenessCheck`, and only when `DEMO_MODE_ENABLED`.
 */
export async function runDemoVerification(
  userId: string,
  sessionId: string,
  api: Api<RawApi>,
  outcomeGate?: OutcomeGate,
): Promise<void> {
  await runFaceMatchVerificationDefault(userId, sessionId, api, {
    ...(outcomeGate ? { outcomeGate } : {}),
    depsOverride: {
      fetchReferenceSelfie: async () => ({
        ok: true,
        selfie: { buffer: STUB_JPEG, mime: "image/jpeg" },
      }),
      uploadSelfie: async () => ({ path: STUB_SELFIE_PATH }),
      // The pipeline downloads each profile photo before comparing it. In demo
      // the comparison ignores the bytes, so returning a stub keeps the run
      // independent of Telegram/Supabase availability — a demo must not fail
      // its identity step because a photo download blipped.
      downloadProfileImage: async () => STUB_JPEG,
      compareFaces: async () => ({
        ok: true,
        similarity: 0.99,
        faceFound: true,
      }),
    },
  });
}

/**
 * Release the in-flight liveness session binding without reading its result.
 *
 * The production path clears `pendingLivenessSessionId` only after AWS returns
 * a terminal state. Demo never asks AWS, so it must clear the binding itself —
 * otherwise a second attempt would be refused with `session_mismatch` against
 * a session nobody is going to complete.
 */
export async function releaseDemoLivenessSession(userId: string): Promise<void> {
  await prisma.user
    .update({ where: { id: userId }, data: { pendingLivenessSessionId: null } })
    .catch(() => {
      /* best-effort: a stale binding only costs the visitor one retry */
    });
}
