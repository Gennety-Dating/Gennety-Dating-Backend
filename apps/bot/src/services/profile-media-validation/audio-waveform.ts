import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { VOICE_PROMPT_WAVEFORM_BUCKETS } from "@gennety/shared";
import { runMediaCommand } from "./media-process.js";
import { withTempMediaDirectory, writePrivateMediaFile } from "./temp-media.js";

/**
 * Precompute the bars a native player draws before it has fetched any audio.
 *
 * Telegram draws its own waveform and ignores this entirely, so on the Telegram
 * rail it buys nothing today. It is computed anyway, at ingest, from a buffer
 * we have already downloaded for moderation — because the alternative is
 * computing it later from source bytes that may be gone. A Telegram-recorded
 * prompt is stored as a `file_id`, and Telegram is free to stop serving that
 * file; a backfill over recordings whose audio no longer exists is not a
 * backfill, it is a data loss discovered late.
 */

/** Sample rate for the decode. Amplitude envelope needs no fidelity at all. */
const DECODE_RATE = 8000;

export async function computeWaveformPeaks(
  audio: Buffer,
  buckets: number = VOICE_PROMPT_WAVEFORM_BUCKETS,
): Promise<number[] | null> {
  if (audio.byteLength === 0 || buckets <= 0) return null;

  try {
    return await withTempMediaDirectory(async (directory) => {
      const input = join(directory, "voice-prompt-input");
      const output = join(directory, "voice-prompt.pcm");
      await writePrivateMediaFile(input, audio);

      await runMediaCommand(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          input,
          // Mono signed 16-bit little-endian at a low rate: the smallest
          // representation an envelope can be read from.
          "-ac",
          "1",
          "-ar",
          String(DECODE_RATE),
          "-f",
          "s16le",
          "-y",
          output,
        ],
        { timeoutMs: 15_000 },
      );

      const pcm = await readFile(output);
      return peaksFromPcm(pcm, buckets);
    });
  } catch {
    // Never a rejection reason. The waveform is decoration on the Telegram
    // rail and a progressive enhancement on the native one; a clip that
    // ffmpeg cannot decode but Whisper and the moderator can is still a
    // perfectly good voice prompt.
    return null;
  }
}

/**
 * RMS per bucket, normalized 0..100 against the loudest bucket.
 *
 * Normalizing against the clip's OWN peak rather than full scale is what makes
 * a quiet recording legible: absolute levels would render someone speaking
 * softly as a flat line, which reads as a broken clip rather than a quiet one.
 * The cost is that the bars say nothing about absolute loudness — which is
 * correct, since nothing in the product cares.
 */
export function peaksFromPcm(pcm: Buffer, buckets: number): number[] | null {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0 || buckets <= 0) return null;

  const perBucket = Math.max(1, Math.floor(samples / buckets));
  const rms: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * perBucket;
    const end = bucket === buckets - 1 ? samples : Math.min(samples, start + perBucket);
    if (start >= end) {
      rms.push(0);
      continue;
    }
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      const sample = pcm.readInt16LE(i * 2) / 32768;
      sum += sample * sample;
    }
    rms.push(Math.sqrt(sum / (end - start)));
  }

  const loudest = Math.max(...rms);
  if (loudest <= 0) return rms.map(() => 0);
  return rms.map((value) => Math.round((value / loudest) * 100));
}
