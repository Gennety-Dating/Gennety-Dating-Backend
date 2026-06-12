import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;
const HASH_PIXEL_COUNT = HASH_WIDTH * HASH_HEIGHT;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ImageFingerprint {
  sha256: string;
  differenceHash: string;
}

export type DuplicateClassification =
  | { kind: "exact"; distance: 0 }
  | { kind: "near"; distance: number }
  | { kind: "ambiguous"; distance: number }
  | { kind: "distinct"; distance: number };

export interface ImageFingerprintOptions {
  normalizeToGrayscale?: (buffer: Buffer) => Promise<Buffer>;
}

export async function fingerprintImage(
  buffer: Buffer,
  options: ImageFingerprintOptions = {},
): Promise<ImageFingerprint> {
  const normalize = options.normalizeToGrayscale ?? normalizeToGrayscale;
  const pixels = await normalize(buffer);
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    differenceHash: differenceHashFromGrayscale(pixels),
  };
}

export function differenceHashFromGrayscale(pixels: Uint8Array): string {
  if (pixels.length !== HASH_PIXEL_COUNT) {
    throw new Error(`Expected ${HASH_PIXEL_COUNT} grayscale pixels`);
  }

  let bits = 0n;
  let bitIndex = 0n;
  for (let y = 0; y < HASH_HEIGHT; y++) {
    const rowStart = y * HASH_WIDTH;
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const left = pixels[rowStart + x]!;
      const right = pixels[rowStart + x + 1]!;
      if (left > right) bits |= 1n << bitIndex;
      bitIndex++;
    }
  }

  return bits.toString(16).padStart(16, "0");
}

export function hammingDistance64(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/iu.test(a) || !/^[0-9a-f]{16}$/iu.test(b)) {
    throw new Error("Difference hashes must be 16 hexadecimal characters");
  }

  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (value !== 0n) {
    value &= value - 1n;
    distance++;
  }
  return distance;
}

export function classifyDuplicate(
  candidate: ImageFingerprint,
  existing: ImageFingerprint,
  thresholds: { nearMax?: number; ambiguousMax?: number } = {},
): DuplicateClassification {
  if (candidate.sha256 === existing.sha256) {
    return { kind: "exact", distance: 0 };
  }

  const nearMax = thresholds.nearMax ?? 5;
  const ambiguousMax = thresholds.ambiguousMax ?? 12;
  const distance = hammingDistance64(
    candidate.differenceHash,
    existing.differenceHash,
  );

  if (distance <= nearMax) return { kind: "near", distance };
  if (distance <= ambiguousMax) return { kind: "ambiguous", distance };
  return { kind: "distinct", distance };
}

async function normalizeToGrayscale(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vf",
        `scale=${HASH_WIDTH}:${HASH_HEIGHT}:flags=lanczos,format=gray`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("ffmpeg image normalization timed out"));
    }, DEFAULT_TIMEOUT_MS);

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      const pixels = Buffer.concat(stdout);
      if (pixels.length !== HASH_PIXEL_COUNT) {
        reject(new Error("ffmpeg returned an invalid grayscale frame"));
        return;
      }
      resolve(pixels);
    }

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(
          new Error(
            detail
              ? `ffmpeg image normalization failed: ${detail}`
              : `ffmpeg image normalization failed with code ${code}`,
          ),
        );
        return;
      }
      finish();
    });

    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(buffer);
  });
}
