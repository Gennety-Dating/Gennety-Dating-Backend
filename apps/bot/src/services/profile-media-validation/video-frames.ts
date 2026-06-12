import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { VideoFrame } from "./types.js";
import { runMediaCommand } from "./media-process.js";

const FRAME_SCALE =
  "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'";

export async function extractVideoFrames(
  videoPath: string,
  outputDirectory: string,
  durationSeconds: number,
  maximumFrames: number,
): Promise<VideoFrame[]> {
  const uniformCount = Math.min(12, maximumFrames);
  const uniform = await mapWithConcurrency(
    Array.from({ length: uniformCount }, (_, index) => index),
    4,
    async (index) => {
      const timestamp = ((index + 0.5) * durationSeconds) / uniformCount;
      const path = join(
        outputDirectory,
        `uniform-${String(index).padStart(3, "0")}.jpg`,
      );
      await runMediaCommand(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          timestamp.toFixed(3),
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-vf",
          FRAME_SCALE,
          "-q:v",
          "3",
          "-y",
          path,
        ],
        { timeoutMs: 15_000 },
      );
      return {
        buffer: await readFile(path),
        timestampSeconds: timestamp,
      };
    },
  );

  const remaining = Math.max(0, maximumFrames - uniform.length);
  if (remaining === 0) return uniform;

  const scenePattern = join(outputDirectory, "scene-%03d.jpg");
  const sceneResult = await runMediaCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "info",
      "-i",
      videoPath,
      "-vf",
      `select='gt(scene,0.32)',showinfo,${FRAME_SCALE}`,
      "-fps_mode",
      "vfr",
      "-frames:v",
      String(remaining),
      "-q:v",
      "3",
      "-y",
      scenePattern,
    ],
    { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 },
  );

  const timestamps = Array.from(
    sceneResult.stderr
      .toString("utf8")
      .matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/gu),
    (match) => Number(match[1]),
  );
  const files = (await readdir(outputDirectory))
    .filter((name) => /^scene-\d+\.jpg$/u.test(name))
    .sort()
    .slice(0, remaining);
  const sceneFrames = await Promise.all(
    files.map(async (name, index) => ({
      buffer: await readFile(join(outputDirectory, name)),
      timestampSeconds:
        timestamps[index] ?? ((index + 1) * durationSeconds) / (files.length + 1),
    })),
  );

  return deduplicateByTimestamp([...uniform, ...sceneFrames]).slice(
    0,
    maximumFrames,
  );
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

function deduplicateByTimestamp(frames: VideoFrame[]): VideoFrame[] {
  const sorted = [...frames].sort(
    (a, b) => a.timestampSeconds - b.timestampSeconds,
  );
  const result: VideoFrame[] = [];
  for (const frame of sorted) {
    if (
      result.some(
        (existing) =>
          Math.abs(existing.timestampSeconds - frame.timestampSeconds) < 0.6,
      )
    ) {
      continue;
    }
    result.push(frame);
  }
  return result;
}

export async function extractVideoAudio(
  videoPath: string,
  outputPath: string,
): Promise<Buffer> {
  await runMediaCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      "-y",
      outputPath,
    ],
    { timeoutMs: 30_000 },
  );
  return readFile(outputPath);
}
