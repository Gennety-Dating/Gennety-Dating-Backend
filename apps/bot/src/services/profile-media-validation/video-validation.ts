import { join } from "node:path";
import {
  PROFILE_VIDEO_MAX_FILE_SIZE_BYTES,
  VIDEO_SAMPLE_TARGET_FRAMES,
} from "@gennety/shared";
import { env } from "../../config.js";
import { detectModerationLabels } from "../face-match.js";
import { transcribeVideoAudio } from "./audio-transcription.js";
import { combineModerationResults } from "./moderation-policy.js";
import { moderateImageWithOpenAI, moderateTextWithOpenAI } from "./openai-moderation.js";
import { withTempMediaDirectory, writePrivateMediaFile } from "./temp-media.js";
import { extractVideoAudio, extractVideoFrames } from "./video-frames.js";
import { probeVideo, type VideoProbe } from "./video-probe.js";
import type { MediaValidationResult, VideoFrame } from "./types.js";

const MAX_DURATION_SECONDS = 60;

export interface ValidatedVideo {
  durationSeconds: number;
  sampledFrameCount: number;
}

export interface VideoValidationInput {
  video: Buffer;
}

export interface VideoValidationDeps {
  withTempDirectory: typeof withTempMediaDirectory;
  writeFile: typeof writePrivateMediaFile;
  probe: typeof probeVideo;
  extractFrames: typeof extractVideoFrames;
  extractAudio: typeof extractVideoAudio;
  moderateImageOpenAI: typeof moderateImageWithOpenAI;
  moderateImageAws: typeof detectModerationLabels;
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
  transcribeAudio: transcribeVideoAudio,
  moderateText: moderateTextWithOpenAI,
};

/**
 * Validate a profile video for *safety only*.
 *
 * The profile video is display-only (never counted toward MIN_PHOTOS, never
 * used by matching or face-match verification), so it does NOT carry an
 * identity gate: we used to require the owner's face in a share of sampled
 * frames and to match a profile anchor, but that reused the brittle
 * cross-image CompareFaces path and bounced plenty of legitimate
 * friends/scenery/party videos. We keep the strict NSFW / violence checks the
 * product cares about — every sampled frame is moderated (OpenAI + AWS) and the
 * audio transcript is moderated — and accept anything that is safe.
 */
export async function validateProfileVideo(
  input: VideoValidationInput,
  options: {
    deps?: VideoValidationDeps;
    maximumFrames?: number;
  } = {},
): Promise<MediaValidationResult<ValidatedVideo>> {
  if (input.video.byteLength === 0) {
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
          options.maximumFrames ?? VIDEO_SAMPLE_TARGET_FRAMES,
        );
      } catch {
        return unavailable();
      }
      if (expired()) return unavailable();
      // No frames sampled = we never actually inspected the video for unsafe
      // content. Fail closed to a retryable "unavailable" rather than accept
      // an unmoderated video.
      if (frames.length === 0) return unavailable();

      for (const frame of frames) {
        const frameSignal = combineModerationResults(
          await Promise.all([
            deps.moderateImageOpenAI(frame.buffer, "image/jpeg", {
              timeoutMs: Math.min(15_000, remaining()),
            }),
            deps.moderateImageAws(frame.buffer, {
              timeoutMs: Math.min(10_000, remaining()),
            }),
          ]),
        );
        if (expired()) return unavailable();
        if (frameSignal.kind === "blocked" || frameSignal.kind === "review") {
          return reject("unsafe_content");
        }
        if (frameSignal.kind === "unavailable") return unavailable();
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

      return {
        ok: true,
        value: {
          durationSeconds: probe.durationSeconds,
          sampledFrameCount: frames.length,
        },
      };
    });
  } catch {
    return unavailable();
  }
}

function reject(
  reason: "unsafe_content" | "video_too_long" | "video_too_large_to_check",
): MediaValidationResult<ValidatedVideo> {
  return { ok: false, reason, retryable: false };
}

function unavailable(): MediaValidationResult<ValidatedVideo> {
  return { ok: false, reason: "processing_unavailable", retryable: true };
}
