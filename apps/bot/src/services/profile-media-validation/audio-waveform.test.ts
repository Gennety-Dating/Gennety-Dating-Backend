import { describe, expect, it } from "vitest";
import { peaksFromPcm } from "./audio-waveform.js";

/** Build s16le mono PCM from a per-sample amplitude in -1..1. */
function pcm(samples: readonly number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => {
    buffer.writeInt16LE(Math.round(value * 32767), index * 2);
  });
  return buffer;
}

describe("peaksFromPcm", () => {
  it("returns exactly the requested number of buckets", () => {
    const peaks = peaksFromPcm(pcm(Array.from({ length: 4000 }, () => 0.5)), 40);
    expect(peaks).toHaveLength(40);
  });

  it("normalizes against the clip's own peak, so a quiet recording is still legible", () => {
    // Both clips have the same SHAPE at very different absolute levels. A
    // full-scale normalization would render the quiet one as a flat line,
    // which reads as broken audio rather than as someone speaking softly.
    const shape = [0.1, 0.1, 1.0, 1.0];
    const loud = peaksFromPcm(pcm(shape), 4);
    const quiet = peaksFromPcm(pcm(shape.map((v) => v * 0.05)), 4);
    expect(loud).toEqual(quiet);
    expect(loud?.at(-1)).toBe(100);
  });

  it("renders digital silence as flat zeros rather than dividing by zero", () => {
    expect(peaksFromPcm(pcm(Array.from({ length: 400 }, () => 0)), 4)).toEqual([0, 0, 0, 0]);
  });

  it("keeps every peak inside 0..100", () => {
    const peaks = peaksFromPcm(
      pcm(Array.from({ length: 2000 }, (_, i) => Math.sin(i / 7))),
      40,
    );
    expect(peaks).not.toBeNull();
    for (const peak of peaks ?? []) {
      expect(peak).toBeGreaterThanOrEqual(0);
      expect(peak).toBeLessThanOrEqual(100);
    }
  });

  it("returns null for empty input rather than an array of zeros", () => {
    // The caller distinguishes "no waveform" from "a silent waveform": the
    // first is stored as [] and the native player falls back, the second is
    // a real measurement of a real clip.
    expect(peaksFromPcm(Buffer.alloc(0), 40)).toBeNull();
  });
});
