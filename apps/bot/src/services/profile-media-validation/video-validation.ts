import { join } from "node:path";
import { PROFILE_VIDEO_MAX_FILE_SIZE_BYTES } from "@gennety/shared";
import { env } from "../../config.js";
import {
  compareFaces,
  detectFaces,
  detectModerationLabels,
} from "../face-match.js";
import { transcribeVideoAudio } from "./audio-transcription.js";
import { combineModerationResults } from "./moderation-policy.js";
import { moderateImageWithOpenAI, moderateTextWithOpenAI } from "./openai-moderation.js";
import { withTempMediaDirectory, writePrivateMediaFile } from "./temp-media.js";
import { extractVideoAudio, extractVideoFrames } from "./video-frames.js";
import { probeVideo, type VideoProbe } from "./video-probe.js";
import type {
  DetectedFace,
  MediaValidationResult,
  VideoFrame,
  VideoOwnerEvidence,
} from "./types.js";

const MAX_DURATION_SECONDS = 60;
const MIN_MATCHED_FRAMES = 3;
const MIN_MATCHED_CLUSTERS = 2;
const MIN_FACE_AREA = 0.01;
const MIN_FACE_SHARPNESS = 0.15;

export interface ValidatedVideo {
  evidence: VideoOwnerEvidence;
  durationSeconds: number;
  sampledFrameCount: number;
}

export interface VideoValidationInput {
  video: Buffer;
  identityReference: Buffer;
}

export interface VideoValidationDeps {
  withTempDirectory: typeof withTempMediaDirectory;
  writeFile: typeof writePrivateMediaFile;
  probe: typeof probeVideo;
  extractFrames: typeof extractVideoFrames;
  extractAudio: typeof extractVideoAudio;
  moderateImageOpenAI: typeof moderateImageWithOpenAI;
  moderateImageAws: typeof detectModerationLabels;
  detectFaces: typeof detectFaces;
  compareFaces: typeof compareFaces;
  transcribeAudio: typeof transcribeVideoAudio;
  moderateText: typeof moderateTextWithOpenAI;
}

const defaultDeps: VideoValidationDeps = {
  withTempDirectory: withTempMediaDirectory,
  writeFile: writePrivateMediaFile,
  probe: probeVideo,
  extractFrames: extractVideoFrames,
  extractAudio: extractVideoAudio,
  moderateImageOpenAI: moderateImageWithOpenAI,
  moderateImageAws: detectModerationLabels,
  detectFaces,
  compareFaces,
  transcribeAudio: transcribeVideoAudio,
  moderateText: moderateTextWithOpenAI,
};

export async function validateProfileVideo(
  input: VideoValidationInput,
  options: {
    deps?: VideoValidationDeps;
    maximumFrames?: number;
    identityThreshold?: number;
  } = {},
): Promise<MediaValidationResult<ValidatedVideo>> {
  if (input.video.byteLength === 0 || input.identityReference.byteLength === 0) {
    return unavailable();
  }
  if (input.video.byteLength > PROFILE_VIDEO_MAX_FILE_SIZE_BYTES) {
    return reject("video_too_large_to_check");
  }
  const deps = options.deps ?? defaultDeps;
  const deadline = Date.now() + env.PROFILE_VIDEO_VALIDATION_TIMEOUT_MS;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  const expired = (): boolean => Date.now() >= deadline;

  try {
    return await deps.withTempDirectory(async (directory) => {
      const videoPath = join(directory, "input-video");
      await deps.writeFile(videoPath, input.video);

      let probe: VideoProbe;
      try {
        probe = await deps.probe(videoPath);
      } catch {
        return unavailable();
      }
      if (expired()) return unavailable();
      if (probe.durationSeconds > MAX_DURATION_SECONDS) {
        return reject("video_too_long");
      }

      let frames: VideoFrame[];
      try {
        frames = await deps.extractFrames(
          videoPath,
          directory,
          probe.durationSeconds,
          options.maximumFrames ?? env.PROFILE_VIDEO_MAX_ANALYSIS_FRAMES,
        );
      } catch {
        return unavailable();
      }
      if (expired()) return unavailable();
      if (frames.length === 0) return reject("video_owner_missing");

      const frameSignals = await mapWithConcurrency(frames, 4, async (frame) =>
        combineModerationResults(
          await Promise.all([
            deps.moderateImageOpenAI(frame.buffer, "image/jpeg", {
              timeoutMs: Math.min(15_000, remaining()),
            }),
            deps.moderateImageAws(frame.buffer, {
              timeoutMs: Math.min(10_000, remaining()),
            }),
          ]),
        ),
      );
      if (expired()) return unavailable();
      if (
        frameSignals.some(
          (result) => result.kind === "blocked" || result.kind === "review",
        )
      ) {
        return reject("unsafe_content");
      }
      if (frameSignals.some((result) => result.kind === "unavailable")) {
        return unavailable();
      }

      if (probe.hasAudio) {
        let audio: Buffer;
        try {
          audio = await deps.extractAudio(
            videoPath,
            join(directory, "audio.mp3"),
          );
        } catch {
          return unavailable();
        }
        const transcript = await deps.transcribeAudio(audio, {
          timeoutMs: Math.min(45_000, remaining()),
        });
        if (!transcript.ok) return unavailable();
        const audioModeration = await deps.moderateText(transcript.text, {
          timeoutMs: Math.min(15_000, remaining()),
        });
        if (!audioModeration.ok) return unavailable();
        const combinedAudio = combineModerationResults([audioModeration]);
        if (
          combinedAudio.kind === "blocked" ||
          combinedAudio.kind === "review"
        ) {
          return reject("unsafe_content");
        }
      }

      const threshold =
        options.identityThreshold ?? env.FACE_MATCH_THRESHOLD_VERIFY;
      const matched: Array<{
        timestampSeconds: number;
        highQuality: boolean;
      }> = [];

      const frameIdentity = await mapWithConcurrency(frames, 4, async (frame) => {
        const faces = await deps.detectFaces(frame.buffer, {
          timeoutMs: Math.min(10_000, remaining()),
        });
        if (!faces.ok || faces.faces.length === 0) {
          return { kind: faces.ok ? "no_face" as const : "unavailable" as const };
        }
        const comparison = await deps.compareFaces(
          input.identityReference,
          frame.buffer,
          { timeoutMs: Math.min(10_000, remaining()) },
        );
        if (!comparison.ok) return { kind: "unavailable" as const };
        if (!comparison.faceFound || comparison.similarity < threshold) {
          return { kind: "not_owner" as const };
        }
        return {
          kind: "owner" as const,
          timestampSeconds: frame.timestampSeconds,
          highQuality: isHighQualityMatchedFace(
            comparison.matchedFace,
            faces.faces,
          ),
        };
      });
      if (expired()) return unavailable();

      if (frameIdentity.some((result) => result.kind === "unavailable")) {
        return unavailable();
      }
      for (const result of frameIdentity) {
        if (result.kind === "owner") matched.push(result);
      }

      const evidence = buildOwnerEvidence(
        matched,
        probe.durationSeconds,
      );
      if (evidence.matchedFrameCount === 0) {
        return reject("video_owner_missing");
      }
      if (!ownerEvidencePasses(evidence, probe.durationSeconds)) {
        return reject("video_owner_too_brief");
      }

      return {
        ok: true,
        value: {
          evidence,
          durationSeconds: probe.durationSeconds,
          sampledFrameCount: frames.length,
        },
      };
    });
  } catch {
    return unavailable();
  }
}

export function buildOwnerEvidence(
  matches: readonly {
    timestampSeconds: number;
    highQuality: boolean;
  }[],
  durationSeconds: number,
): VideoOwnerEvidence {
  const sorted = [...matches].sort(
    (a, b) => a.timestampSeconds - b.timestampSeconds,
  );
  const separation = Math.max(2, durationSeconds * 0.2);
  let clusters = 0;
  let lastClusterStart = Number.NEGATIVE_INFINITY;
  const thirds = new Set<number>();

  for (const match of sorted) {
    if (match.timestampSeconds - lastClusterStart >= separation) {
      clusters++;
      lastClusterStart = match.timestampSeconds;
    }
    thirds.add(
      Math.min(
        2,
        Math.max(
          0,
          Math.floor((match.timestampSeconds / durationSeconds) * 3),
        ),
      ),
    );
  }

  return {
    matchedFrameCount: sorted.length,
    matchedClusterCount: clusters,
    matchedTemporalThirds: thirds.size,
    hasHighQualityMatch: sorted.some((match) => match.highQuality),
  };
}

export function ownerEvidencePasses(
  evidence: VideoOwnerEvidence,
  durationSeconds: number,
): boolean {
  return (
    evidence.matchedFrameCount >= MIN_MATCHED_FRAMES &&
    evidence.matchedClusterCount >= MIN_MATCHED_CLUSTERS &&
    evidence.hasHighQualityMatch &&
    (durationSeconds <= 20 || evidence.matchedTemporalThirds >= 2)
  );
}

function isHighQualityMatchedFace(
  matchedFace: {
    confidence: number;
    boundingBox: DetectedFace["boundingBox"];
  } | undefined,
  detectedFaces: readonly DetectedFace[],
): boolean {
  const matchedBox = matchedFace?.boundingBox;
  if (!matchedFace || !matchedBox) return false;
  const detected = detectedFaces
    .filter((face) => face.boundingBox)
    .map((face) => ({
      face,
      overlap: intersectionOverUnion(matchedBox, face.boundingBox!),
    }))
    .sort((a, b) => b.overlap - a.overlap)[0];
  if (!detected || detected.overlap < 0.4) return false;

  const area = matchedBox.width * matchedBox.height;
  return (
    matchedFace.confidence >= 0.9 &&
    detected.face.confidence >= 0.9 &&
    area >= MIN_FACE_AREA &&
    (detected.face.sharpness === null ||
      detected.face.sharpness >= MIN_FACE_SHARPNESS)
  );
}

function intersectionOverUnion(
  first: NonNullable<DetectedFace["boundingBox"]>,
  second: NonNullable<DetectedFace["boundingBox"]>,
): number {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(
    first.left + first.width,
    second.left + second.width,
  );
  const bottom = Math.min(
    first.top + first.height,
    second.top + second.height,
  );
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union =
    first.width * first.height +
    second.width * second.height -
    intersection;
  return union > 0 ? intersection / union : 0;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= items.length) return;
          results[index] = await operation(items[index]!);
        }
      },
    ),
  );
  return results;
}

function reject(
  reason:
    | "unsafe_content"
    | "video_owner_missing"
    | "video_owner_too_brief"
    | "video_too_long"
    | "video_too_large_to_check",
): MediaValidationResult<ValidatedVideo> {
  return { ok: false, reason, retryable: false };
}

function unavailable(): MediaValidationResult<ValidatedVideo> {
  return { ok: false, reason: "processing_unavailable", retryable: true };
}
