import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";

/**
 * Re-encode an arbitrary image buffer (JPEG / WebP / PNG …) to a real PNG.
 *
 * satori embeds images into the SVG as data URIs and the template tags every
 * one as `image/png`; Telegram profile photos and Google Places photos are
 * actually JPEG, so without this normalization resvg silently fails to decode
 * the mislabeled bytes and the image vanishes from the card. Routing every
 * photo through Skia (which the blur path already does) guarantees the bytes
 * match the declared `image/png` mime.
 *
 * Returns `null` on any decode failure so the caller can fall back to a
 * placeholder / gradient instead of embedding undecodable bytes.
 */
export async function toPngBuffer(buffer: Buffer): Promise<Buffer | null> {
  try {
    const img = await loadImage(buffer);
    const canvas = createCanvas(img.width, img.height) as Canvas;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}
