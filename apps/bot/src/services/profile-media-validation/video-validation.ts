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

/**
 * How many sampled frames are in flight with the moderation providers at once
 * (each frame = one OpenAI + one AWS call). Checked one by one, a 12-frame
 * clip cost twelve provider round-trips back to back; six at a time makes it
 * two, without one upload bursting all twelve frames into the providers' rate
 * limits alongside everyone else's photo checks.
 */
export const FRAME_MODERATION_CONCURRENCY = 6;

type BranchVerdict = "safe" | "unsafe" | "unavailable";

interface FrameBranchOutcome {
  verdict: BranchVerdict;
  sampledFrameCount: number;
}

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

      // The frame branch and the audio branch inspect independent things and
      // talk to different providers, so they run side by side: on a short clip
      // the Whisper round-trip used to start only after the last frame came
      // back, and the user watched "100%" for the sum of both. `unsafeFound` is
      // shared so whichever branch rejects first stops the other from launching
      // more provider calls — the verdict is already decided at that point.
      const shared = { unsafeFound: false };

      const frameBranch = async (): Promise<FrameBranchOutcome> => {
        let frames: VideoFrame[];
        try {
          frames = await deps.extractFrames(
            videoPath,
            directory,
            probe.durationSeconds,
            options.maximumFrames ?? VIDEO_SAMPLE_TARGET_FRAMES,
          );
        } catch {
          return { verdict: "unavailable", sampledFrameCount: 0 };
        }
        if (expired()) return { verdict: "unavailable", sampledFrameCount: 0 };
        // No frames sampled = we never actually inspected the video for unsafe
        // content. Fail closed to a retryable "unavailable" rather than accept
        // an unmoderated video.
        if (frames.length === 0) {
          return { verdict: "unavailable", sampledFrameCount: 0 };
        }

        const verdict = await moderateFramesConcurrently(
          frames,
          FRAME_MODERATION_CONCURRENCY,
          () => shared.unsafeFound,
          async (frame): Promise<BranchVerdict> => {
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
            // A blocked/review frame is a verdict on the content and stands
            // even if it arrived after the deadline — answering "try again"
            // would only invite the same clip back.
            if (frameSignal.kind === "blocked" || frameSignal.kind === "review") {
              shared.unsafeFound = true;
              return "unsafe";
            }
            if (expired()) return "unavailable";
            if (frameSignal.kind === "unavailable") return "unavailable";
            return "safe";
          },
        );
        return { verdict, sampledFrameCount: frames.length };
      };

      const audioBranch = async (): Promise<BranchVerdict> => {
        if (!probe.hasAudio) return "safe";
        let audio: Buffer;
        try {
          audio = await deps.extractAudio(
            videoPath,
            join(directory, "audio.mp3"),
          );
        } catch {
          return "unavailable";
        }
        // Frames already rejected the clip: the answer cannot change, so do
        // not spend a Whisper call on it. "unavailable" here is never the
        // final verdict — unsafe from the other branch wins below.
        if (shared.unsafeFound) return "unavailable";
        const transcript = await deps.transcribeAudio(audio, {
          timeoutMs: Math.min(45_000, remaining()),
        });
        if (!transcript.ok) return "unavailable";
        if (shared.unsafeFound) return "unavailable";
        const audioModeration = await deps.moderateText(transcript.text, {
          timeoutMs: Math.min(15_000, remaining()),
        });
        if (!audioModeration.ok) return "unavailable";
        const combinedAudio = combineModerationResults([audioModeration]);
        if (
          combinedAudio.kind === "blocked" ||
          combinedAudio.kind === "review"
        ) {
          shared.unsafeFound = true;
          return "unsafe";
        }
        return "safe";
      };

      // A throw inside a branch (a provider client bug, an fs error) used to
      // escape to the outer catch as "unavailable"; it still does, but per
      // branch, so the other branch's unsafe verdict is not lost to it. Both
      // branches are awaited before returning: the temp directory they read
      // from is removed as soon as this callback settles.
      const [frameOutcome, audioVerdict] = await Promise.all([
        frameBranch().catch(
          (): FrameBranchOutcome => ({ verdict: "unavailable", sampledFrameCount: 0 }),
        ),
        audioBranch().catch((): BranchVerdict => "unavailable"),
      ]);

      // Unsafe beats unavailable: it is the stricter answer and the
      // non-retryable one, so a clip with one bad frame cannot be re-rolled
      // until a provider hiccup elsewhere happens to answer first.
      if (frameOutcome.verdict === "unsafe" || audioVerdict === "unsafe") {
        return reject("unsafe_content");
      }
      if (frameOutcome.verdict === "unavailable" || audioVerdict === "unavailable") {
        return unavailable();
      }

      return {
        ok: true,
        value: {
          durationSeconds: probe.durationSeconds,
          sampledFrameCount: frameOutcome.sampledFrameCount,
        },
      };
    });
  } catch {
    return unavailable();
  }
}

/**
 * Moderate every frame with at most `concurrency` checks in flight, and stop
 * launching new ones as soon as any frame comes back not-safe (or `shouldStop`
 * says the audio branch already rejected the clip).
 *
 * Same verdict as the old one-by-one loop for any mix of per-frame results,
 * with one deliberate tie-break: when frames in flight come back both unsafe
 * and unavailable, unsafe wins (the loop answered whichever came first in
 * frame order). Safe requires every frame to have been checked and come back
 * safe — a frame skipped by an early stop is never counted as safe.
 */
async function moderateFramesConcurrently(
  frames: readonly VideoFrame[],
  concurrency: number,
  shouldStop: () => boolean,
  check: (frame: VideoFrame) => Promise<BranchVerdict>,
): Promise<BranchVerdict> {
  let nextIndex = 0;
  let checked = 0;
  let sawUnsafe = false;
  let sawUnavailable = false;
  const stopped = (): boolean => sawUnsafe || sawUnavailable || shouldStop();

  await Promise.all(
    Array.from({ length: Math.min(concurrency, frames.length) }, async () => {
      while (!stopped()) {
        const index = nextIndex++;
        if (index >= frames.length) return;
        let verdict: BranchVerdict;
        try {
          verdict = await check(frames[index]!);
        } catch {
          verdict = "unavailable";
        }
        checked++;
        if (verdict === "unsafe") sawUnsafe = true;
        else if (verdict === "unavailable") sawUnavailable = true;
      }
    }),
  );

  if (sawUnsafe) return "unsafe";
  if (sawUnavailable || checked < frames.length) return "unavailable";
  return "safe";
}

function reject(
  reason: "unsafe_content" | "video_too_long" | "video_too_large_to_check",
): MediaValidationResult<ValidatedVideo> {
  return { ok: false, reason, retryable: false };
}

function unavailable(): MediaValidationResult<ValidatedVideo> {
  return { ok: false, reason: "processing_unavailable", retryable: true };
}
