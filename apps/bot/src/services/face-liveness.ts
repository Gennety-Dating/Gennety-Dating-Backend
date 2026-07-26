import {
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  type CreateFaceLivenessSessionCommandOutput,
  type GetFaceLivenessSessionResultsCommandOutput,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import { env } from "../config.js";
import { getRekognitionClient } from "./rekognition-client.js";

/**
 * AWS Rekognition Face Liveness — the identity provider.
 *
 * Replaces the Persona hosted flow (removed 2026-07-26). Responsibilities:
 *   1. Mint a liveness session for a user about to run the check.
 *   2. Read the terminal result — a confidence score plus the *reference
 *      image*, the high-quality frame the rest of the pipeline face-matches
 *      against every profile photo.
 *
 * THE 3-MINUTE RULE — the constraint this whole module is shaped around.
 * Per AWS, "a SessionId expires 3 minutes after it's sent, making all Liveness
 * data associated with the session (sessionID, reference image, audit images,
 * etc.) unavailable". There is no later re-fetch the way Persona allowed, so:
 *   - `getLivenessResult` MUST run in the same request the client reports
 *     completion on, and
 *   - the reference image MUST be persisted to our own storage immediately.
 * Every rerun of the face-match pipeline (photo edit, admin recheck) therefore
 * reads the STORED selfie, never this provider.
 *
 * Failure policy: a liveness check that does not clearly pass is RETRYABLE —
 * the user runs a new session. It is never `rejected` (that status is reserved
 * for a real, detected face in the photo set that isn't the verified person)
 * and never `pending_review` (there is nothing for an admin to adjudicate on a
 * shaky camera capture).
 *
 * Region: liveness runs in `FACE_LIVENESS_REGION` (eu-west-1), NOT the
 * `AWS_REGION` the rest of Rekognition uses (eu-central-1 does not serve Face
 * Liveness). See `rekognition-client.ts`.
 *
 * Never throws — branch on the discriminated `ok` field.
 */

/** Audit images are extra frames from the selfie video. We ask for none:
 *  the reference image alone drives face-matching, and every additional
 *  biometric artefact is GDPR Article 9 data we would then have to justify. */
const AUDIT_IMAGES_LIMIT = 0;

const DEFAULT_TIMEOUT_MS = 15_000;
const LOG_PREFIX = "[face-liveness]";

export type LivenessProviderError =
  | "not_configured"
  | "session_not_found"
  | "api"
  | "timeout";

export type CreateLivenessSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: LivenessProviderError };

/**
 * Terminal state of a liveness session.
 *
 * - `passed`      — SUCCEEDED and confidence cleared the threshold. Carries the
 *                   reference image; hand it to the face-match pipeline.
 * - `not_live`    — the check ran but did not convince us (FAILED, or SUCCEEDED
 *                   below threshold). Retryable.
 * - `expired`     — the 3-minute window closed before we read the result, or
 *                   AWS reports EXPIRED. Retryable.
 * - `in_progress` — CREATED / IN_PROGRESS: the client reported completion before
 *                   AWS settled. Retryable (rare).
 * - `no_reference`— passed the check but AWS returned no reference image. AWS's
 *                   own guidance is to retry the liveness check.
 */
export type LivenessResult =
  | {
      ok: true;
      outcome: "passed";
      confidence: number;
      referenceImage: Buffer;
    }
  | {
      ok: true;
      outcome: "not_live" | "expired" | "in_progress" | "no_reference";
      confidence: number | null;
      status: string;
    }
  | { ok: false; error: LivenessProviderError };

export interface LivenessOptions {
  /** Inject a Rekognition client (or test double). */
  client?: Pick<RekognitionClient, "send">;
  /** Override the 15s default. */
  timeoutMs?: number;
  /** Override the pass threshold (0..1). Defaults to env. */
  minConfidence?: number;
}

/**
 * Create a Face Liveness session. The returned `sessionId` is handed to the
 * on-device Amplify component, which streams the selfie video to Rekognition
 * itself; the backend never sees the video.
 *
 * NOTE: the clock starts here. The component has ~3 minutes to run the check
 * and report back before the session (and its reference image) evaporates.
 */
export async function createLivenessSession(
  options: LivenessOptions = {},
): Promise<CreateLivenessSessionResult> {
  const client = options.client ?? getRekognitionClient(env.FACE_LIVENESS_REGION);
  if (!client) return { ok: false, error: "not_configured" };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const output = (await client.send(
      new CreateFaceLivenessSessionCommand({
        Settings: { AuditImagesLimit: AUDIT_IMAGES_LIMIT },
      }),
      { abortSignal: controller.signal },
    )) as CreateFaceLivenessSessionCommandOutput;

    if (!output.SessionId) {
      console.error(`${LOG_PREFIX} CreateFaceLivenessSession returned no SessionId`);
      return { ok: false, error: "api" };
    }
    return { ok: true, sessionId: output.SessionId };
  } catch (err) {
    return { ok: false, error: providerError(err, "CreateFaceLivenessSession") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the terminal result of a liveness session and, on a pass, return the
 * reference image bytes.
 *
 * Must be called within 3 minutes of `createLivenessSession` — see the module
 * header. A `SessionNotFoundException` past that window is reported as
 * `expired` (a retryable product state) rather than as an infrastructure
 * error, because from the user's side that is exactly what happened.
 */
export async function getLivenessResult(
  sessionId: string,
  options: LivenessOptions = {},
): Promise<LivenessResult> {
  const client = options.client ?? getRekognitionClient(env.FACE_LIVENESS_REGION);
  if (!client) return { ok: false, error: "not_configured" };

  const minConfidence = options.minConfidence ?? env.FACE_LIVENESS_MIN_CONFIDENCE;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let output: GetFaceLivenessSessionResultsCommandOutput;
  try {
    output = (await client.send(
      new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }),
      { abortSignal: controller.signal },
    )) as GetFaceLivenessSessionResultsCommandOutput;
  } catch (err) {
    const error = providerError(err, "GetFaceLivenessSessionResults");
    // The session aged out (or never existed). To the user this is "your
    // check timed out, run it again", not an outage.
    if (error === "session_not_found") {
      return { ok: true, outcome: "expired", confidence: null, status: "EXPIRED" };
    }
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }

  const status = output.Status ?? "";
  const confidence = normalizeConfidence(output.Confidence);

  if (status === "EXPIRED") {
    return { ok: true, outcome: "expired", confidence, status };
  }
  if (status === "CREATED" || status === "IN_PROGRESS") {
    return { ok: true, outcome: "in_progress", confidence, status };
  }
  if (status !== "SUCCEEDED") {
    // FAILED, or anything AWS adds later — treat as "we couldn't confirm you".
    return { ok: true, outcome: "not_live", confidence, status };
  }
  if (confidence === null || confidence < minConfidence) {
    return { ok: true, outcome: "not_live", confidence, status };
  }

  // We never pass `OutputConfig`, so AWS returns the reference frame as raw
  // bytes rather than an S3 object. A missing frame is AWS's documented
  // "retry the Liveness check" case.
  const bytes = output.ReferenceImage?.Bytes;
  if (!bytes || bytes.length === 0) {
    return { ok: true, outcome: "no_reference", confidence, status };
  }

  return {
    ok: true,
    outcome: "passed",
    confidence,
    referenceImage: Buffer.from(bytes),
  };
}

/** AWS reports 0..100; the rest of the codebase speaks 0..1 (see face-match.ts). */
function normalizeConfidence(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value / 100));
}

/**
 * Collapse an SDK throw into our coarse error union — and log the real AWS
 * error name on the way, because `api` on its own is undebuggable in a
 * production log (an IAM `AccessDeniedException` and a genuine outage would
 * otherwise look identical).
 */
function providerError(err: unknown, operation: string): LivenessProviderError {
  const name = (err as { name?: string }).name;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (name === "SessionNotFoundException") return "session_not_found";
  console.error(`${LOG_PREFIX} ${operation} failed`, {
    name: name ?? "unknown",
    message: (err as { message?: string }).message,
  });
  return "api";
}
