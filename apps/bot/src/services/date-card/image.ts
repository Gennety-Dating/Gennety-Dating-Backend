import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { runRenderJob } from "../render/pool.js";

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
 *
 * Считается вне главного потока (`services/render/pool.ts`) — декодирование и
 * перекодирование фотографии синхронны и блокируют loop.
 */
export async function toPngBuffer(buffer: Buffer): Promise<Buffer | null> {
  const out = await runRenderJob({ kind: "to-png", bytes: buffer });
  return out === null ? null : Buffer.from(out);
}

/**
 * Downscale an image to `targetW` (preserving aspect ratio and the alpha
 * channel) and return PNG bytes. Used to shrink the large brand logo before it
 * is embedded as a data URI in the date-card SVG, so the render does not carry
 * a multi-hundred-KB source image. Returns `null` on decode failure.
 */
export async function resizePng(buffer: Buffer, targetW: number): Promise<Buffer | null> {
  const out = await runRenderJob({ kind: "resize-png", bytes: buffer, targetW });
  return out === null ? null : Buffer.from(out);
}

/**
 * Cover-fit an image into `w×h` and remap it to a two-tone (shadow→highlight)
 * ramp, blending back toward the original by `mix` (0 = original, 1 = full
 * duotone). Used to pull the date-card venue photo into the brand palette so a
 * stock Places/curated image reads as part of the card, not pasted in.
 *
 * Returns `null` on decode failure so the caller falls back to a gradient.
 *
 * Попиксельный цикл на 1000×690 — это 2,76 млн итераций; он тоже уехал в
 * рабочий поток.
 */
export async function duotonePng(
  buffer: Buffer,
  shadow: string,
  high: string,
  w: number,
  h: number,
  mix = 1,
): Promise<Buffer | null> {
  const out = await runRenderJob({
    kind: "duotone",
    bytes: buffer,
    shadow,
    high,
    w,
    h,
    mix,
  });
  return out === null ? null : Buffer.from(out);
}

/**
 * Растеризовать SVG в PNG вне главного потока.
 *
 * Единственная точка входа для всех семи рендереров карточек. До 2026-09-07
 * каждый звал `new Resvg(...).render().asPng()` у себя, на главном потоке —
 * см. обоснование в `services/render/pool.ts`.
 */
export async function svgToPng(
  svg: string,
  fitToWidth?: number,
  background?: string,
): Promise<Buffer> {
  const out = await runRenderJob({
    kind: "svg-to-png",
    svg,
    ...(fitToWidth === undefined ? {} : { fitToWidth }),
    ...(background === undefined ? {} : { background }),
  });
  // `svg-to-png` не возвращает `null`: там нечего декодировать, а поломанный
  // SVG — это исключение, а не пустой результат.
  return Buffer.from(out!);
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
