import { runMediaCommand } from "./media-process.js";

export type SupportedImageMime =
  | "image/heic"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export function sniffImageMime(buffer: Buffer): SupportedImageMime | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (/^(?:heic|heix|hevc|hevx|mif1|msf1)$/u.test(brand)) {
      return "image/heic";
    }
  }
  return null;
}

export async function normalizeProfileImage(buffer: Buffer): Promise<Buffer> {
  if (buffer.byteLength === 0) throw new Error("Image is empty");
  const result = await runMediaCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-q:v",
      "3",
      "pipe:1",
    ],
    {
      input: buffer,
      timeoutMs: 15_000,
      maxOutputBytes: 5 * 1024 * 1024,
    },
  );
  if (result.stdout.byteLength === 0) {
    throw new Error("Image normalization produced no output");
  }
  return result.stdout;
}
