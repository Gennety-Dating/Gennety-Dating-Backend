import { runMediaCommand } from "./media-process.js";

export interface VideoProbe {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  hasAudio: boolean;
}

interface FfprobePayload {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
}

export async function probeVideo(path: string): Promise<VideoProbe> {
  const result = await runMediaCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,duration",
      "-of",
      "json",
      path,
    ],
    { timeoutMs: 10_000 },
  );
  const payload = JSON.parse(result.stdout.toString("utf8")) as FfprobePayload;
  const video = payload.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  const duration = Number(video?.duration ?? payload.format?.duration);
  if (
    !video ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(video.width) ||
    !Number.isFinite(video.height) ||
    !video.codec_name
  ) {
    throw new Error("Video metadata is incomplete");
  }

  return {
    durationSeconds: duration,
    width: video.width!,
    height: video.height!,
    videoCodec: video.codec_name,
    hasAudio:
      payload.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
}
