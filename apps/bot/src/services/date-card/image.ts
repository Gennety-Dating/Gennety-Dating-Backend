import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

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

/**
 * Downscale an image to `targetW` (preserving aspect ratio and the alpha
 * channel) and return PNG bytes. Used to shrink the large brand logo before it
 * is embedded as a data URI in the date-card SVG, so the render does not carry
 * a multi-hundred-KB source image. Returns `null` on decode failure.
 */
export async function resizePng(buffer: Buffer, targetW: number): Promise<Buffer | null> {
  try {
    const img = await loadImage(buffer);
    const w = Math.max(1, Math.round(targetW));
    const h = Math.max(1, Math.round((img.height / img.width) * w));
    const canvas = createCanvas(w, h) as Canvas;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}

/**
 * Cover-fit an image into `w×h` and remap it to a two-tone (shadow→highlight)
 * ramp, blending back toward the original by `mix` (0 = original, 1 = full
 * duotone). Used to pull the date-card venue photo into the brand palette so a
 * stock Places/curated image reads as part of the card, not pasted in.
 *
 * Returns `null` on decode failure so the caller falls back to a gradient.
 */
export async function duotonePng(
  buffer: Buffer,
  shadow: string,
  high: string,
  w: number,
  h: number,
  mix = 1,
): Promise<Buffer | null> {
  try {
    const img = await loadImage(buffer);
    const canvas = createCanvas(w, h) as Canvas;
    const ctx = canvas.getContext("2d");
    // cover-fit
    const ar = img.width / img.height;
    const tr = w / h;
    let dw = w;
    let dh = h;
    let dx = 0;
    let dy = 0;
    if (ar > tr) {
      dh = h;
      dw = h * ar;
      dx = (w - dw) / 2;
    } else {
      dw = w;
      dh = w / ar;
      dy = (h - dh) / 2;
    }
    ctx.drawImage(img, dx, dy, dw, dh);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const [sr, sg, sb] = hexRgb(shadow);
    const [hr, hg, hb] = hexRgb(high);
    for (let i = 0; i < px.length; i += 4) {
      const lum = (0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!) / 255;
      const dr = sr + (hr - sr) * lum;
      const dg = sg + (hg - sg) * lum;
      const db = sb + (hb - sb) * lum;
      px[i] = px[i]! * (1 - mix) + dr * mix;
      px[i + 1] = px[i + 1]! * (1 - mix) + dg * mix;
      px[i + 2] = px[i + 2]! * (1 - mix) + db * mix;
    }
    ctx.putImageData(data, 0, 0);
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}

/**
 * A faint monochrome grain tile baked at low alpha, overlaid on the date card
 * so the flat near-black background reads as filmic rather than plasticky. The
 * result is deterministic enough to cache one buffer for the process lifetime.
 */
export function grainPng(w: number, h: number, alpha: number): Buffer {
  const canvas = createCanvas(w, h) as Canvas;
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = alpha;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toBuffer("image/png");
}
