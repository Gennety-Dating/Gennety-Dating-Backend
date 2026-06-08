/**
 * Content-based image type detection.
 *
 * The client-supplied `Content-Type` / file extension is attacker-controlled,
 * so trusting it alone lets arbitrary bytes flow into the storage + vision
 * pipeline labelled as `image/*` (audit M2). This sniffs the leading magic
 * bytes and returns the real MIME, or `null` when the buffer is not a
 * supported raster image.
 *
 * Supported: JPEG, PNG, GIF, WebP, HEIC/HEIF (iOS Live Photo still frames are
 * JPEG/HEIC). Intentionally rejects SVG (XML → script vector) and anything
 * else.
 */
export type SniffedImageMime =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/heic";

export function sniffImageMime(buf: Buffer): SniffedImageMime | null {
  if (buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: "GIF87a" / "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";

  // WebP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }

  // HEIC/HEIF: ISO-BMFF box `....ftyp` with a heic/heif/mif1 brand.
  if (
    buf[4] === 0x66 && // f
    buf[5] === 0x74 && // t
    buf[6] === 0x79 && // y
    buf[7] === 0x70 // p
  ) {
    const brand = buf.toString("ascii", 8, 12);
    if (["heic", "heix", "heif", "hevc", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }

  return null;
}
