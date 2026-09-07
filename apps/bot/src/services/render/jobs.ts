import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";

/**
 * Чистые вычисления растеризации: строки и байты на входе, байты на выходе.
 *
 * Живут отдельным модулем, потому что исполняются В ДВУХ местах — в рабочем
 * потоке (`worker.ts`) и, если поток поднять не удалось, прямо здесь
 * (`pool.ts` откатывается на inline). Ничего, кроме аргументов задания, эти
 * функции не знают: ни Prisma, ни конфига, ни сети — иначе их нельзя было бы
 * перенести через границу потока.
 */

export type RenderJob =
  | { kind: "svg-to-png"; svg: string; fitToWidth?: number; background?: string }
  | { kind: "to-png"; bytes: Uint8Array }
  | { kind: "resize-png"; bytes: Uint8Array; targetW: number }
  | {
      kind: "duotone";
      bytes: Uint8Array;
      shadow: string;
      high: string;
      w: number;
      h: number;
      mix: number;
    };

/** `null` означает «не удалось декодировать» — вызывающий рисует запасной фон. */
export type RenderResult = Uint8Array | null;

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function svgToPngInline(svg: string, fitToWidth?: number, background?: string): Uint8Array {
  return new Resvg(svg, {
    ...(fitToWidth === undefined ? {} : { fitTo: { mode: "width" as const, value: fitToWidth } }),
    ...(background === undefined ? {} : { background }),
  })
    .render()
    .asPng();
}

async function toPngInline(bytes: Uint8Array): Promise<RenderResult> {
  try {
    const img = await loadImage(Buffer.from(bytes));
    const canvas = createCanvas(img.width, img.height) as Canvas;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}

async function resizeInline(bytes: Uint8Array, targetW: number): Promise<RenderResult> {
  try {
    const img = await loadImage(Buffer.from(bytes));
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

async function duotoneInline(
  bytes: Uint8Array,
  shadow: string,
  high: string,
  w: number,
  h: number,
  mix: number,
): Promise<RenderResult> {
  try {
    const img = await loadImage(Buffer.from(bytes));
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

/** Выполнить задание здесь и сейчас, на том потоке, который вызвал. */
export async function runJobInline(job: RenderJob): Promise<RenderResult> {
  switch (job.kind) {
    case "svg-to-png":
      return svgToPngInline(job.svg, job.fitToWidth, job.background);
    case "to-png":
      return toPngInline(job.bytes);
    case "resize-png":
      return resizeInline(job.bytes, job.targetW);
    case "duotone":
      return duotoneInline(job.bytes, job.shadow, job.high, job.w, job.h, job.mix);
  }
}
