/**
 * Match-card collage compositor. Everything photographic happens here in
 * @napi-rs/canvas — torn-paper photo cutouts, rotations, baked shadows,
 * halftone dot patches and tinted butterfly accents — and comes out as ONE
 * full-card transparent PNG layer. The satori template only stacks flat
 * layers and text on top, because satori has no filters/clip-paths.
 *
 * All randomness (tear jitter, dot skip) is seeded from the match id so the
 * private and share renders of the same match are pixel-identical, and
 * retries reproduce the same card.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, type Canvas, type SKRSContext2D, type Image } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";

export const CARD_W = 1080;
export const CARD_H = 1350;

/* ------------------------------------------------------------------ */
/* Seeded randomness (xmur3 hash → mulberry32 PRNG)                    */
/* ------------------------------------------------------------------ */

function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export type Rng = () => number;

export function seededRng(seed: string): Rng {
  let a = hashSeed(seed) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Torn-paper photo cutouts                                            */
/* ------------------------------------------------------------------ */

/**
 * Jagged rectangle outline: walks the four edges of `w×h` sampling every
 * ~`step`px with a perpendicular jitter of ±`amp`. Corners get half jitter so
 * the silhouette stays recognizably rectangular.
 */
function tornPolygon(w: number, h: number, amp: number, step: number, rnd: Rng): [number, number][] {
  const pts: [number, number][] = [];
  const jitter = (edgeT: number) => {
    const cornerDamp = Math.min(1, 4 * Math.min(edgeT, 1 - edgeT) + 0.35);
    return (rnd() * 2 - 1) * amp * cornerDamp;
  };
  const walk = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(2, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const j = jitter(t);
      pts.push([x0 + (x1 - x0) * t + nx * j, y0 + (y1 - y0) * t + ny * j]);
    }
  };
  walk(0, 0, w, 0, 0, 1); // top    (jitter downward/upward)
  walk(w, 0, w, h, -1, 0); // right
  walk(w, h, 0, h, 0, -1); // bottom
  walk(0, h, 0, 0, 1, 0); // left
  return pts;
}

function tracePolygon(ctx: SKRSContext2D, pts: [number, number][], dx = 0, dy = 0): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]![0] + dx, pts[0]![1] + dy);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0] + dx, pts[i]![1] + dy);
  ctx.closePath();
}

function coverDraw(
  ctx: SKRSContext2D,
  img: Image,
  x: number,
  y: number,
  w: number,
  h: number,
  focusY: number,
): void {
  const ar = img.width / img.height;
  const tr = w / h;
  let dw = w;
  let dh = h;
  if (ar > tr) {
    dh = h;
    dw = h * ar;
  } else {
    dw = w;
    dh = w / ar;
  }
  // Anchor horizontally centered; vertically at `focusY` (faces live in the
  // upper third of profile photos, so 0 keeps heads in frame).
  const dx = x - (dw - w) / 2;
  const dy = y - (dh - h) * focusY;
  ctx.drawImage(img, dx, dy, dw, dh);
}

export interface PhotoSlot {
  /** Center of the cutout on the card. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Rotation in degrees; small ±3–6 reads as hand-placed. */
  angle: number;
  /** true = straight polaroid frame instead of torn-paper edges. */
  straight?: boolean;
  /** Per-slot paper border width; 0 gives a borderless full-bleed photo. */
  border?: number;
  /** Per-slot vertical focus for the cover crop (0 = top of the photo). */
  focusY?: number;
  /** Soft color wash pulled over the tile (use with border 0 only). */
  tint?: { shadow: string; high: string; mix: number };
}

interface CutoutStyle {
  paper: string;
  border: number;
  tearAmp: number;
  shadow: string;
  focusY: number;
}

/** Soft duotone wash blended over a tile so mosaic photos read as one warm set. */
function applyTint(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  tint: { shadow: string; high: string; mix: number },
): void {
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const [sr, sg, sb] = hexRgb(tint.shadow);
  const [hr, hg, hb] = hexRgb(tint.high);
  const mix = tint.mix;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const lum = (0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!) / 255;
    px[i] = px[i]! * (1 - mix) + (sr + (hr - sr) * lum) * mix;
    px[i + 1] = px[i + 1]! * (1 - mix) + (sg + (hg - sg) * lum) * mix;
    px[i + 2] = px[i + 2]! * (1 - mix) + (sb + (hb - sb) * lum) * mix;
  }
  ctx.putImageData(data, 0, 0);
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Render one photo cutout (paper backing + inset photo) on its own canvas. */
function buildCutout(img: Image, w: number, h: number, style: CutoutStyle, rnd: Rng): Canvas {
  const canvas = createCanvas(w, h) as Canvas;
  const ctx = canvas.getContext("2d");
  const b = style.border;
  const outer =
    style.tearAmp > 0 ? tornPolygon(w, h, style.tearAmp, 26, rnd) : ([[0, 0], [w, 0], [w, h], [0, h]] as [number, number][]);
  ctx.save();
  tracePolygon(ctx, outer);
  ctx.clip();
  ctx.fillStyle = style.paper;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const inner =
    style.tearAmp > 0
      ? tornPolygon(w - 2 * b, h - 2 * b, style.tearAmp * 0.75, 24, rnd)
      : ([[0, 0], [w - 2 * b, 0], [w - 2 * b, h - 2 * b], [0, h - 2 * b]] as [number, number][]);
  ctx.save();
  tracePolygon(ctx, inner, b, b);
  ctx.clip();
  coverDraw(ctx, img, b, b, w - 2 * b, h - 2 * b, style.focusY);
  ctx.restore();
  return canvas;
}

/* ------------------------------------------------------------------ */
/* Accents: halftone dots + butterfly silhouettes                      */
/* ------------------------------------------------------------------ */

export interface DotPatch {
  x: number;
  y: number;
  cols: number;
  rows: number;
  r: number;
  gap: number;
  color: string;
  alpha: number;
}

function drawDots(ctx: SKRSContext2D, p: DotPatch, rnd: Rng): void {
  ctx.save();
  ctx.globalAlpha = p.alpha;
  ctx.fillStyle = p.color;
  for (let row = 0; row < p.rows; row++) {
    for (let col = 0; col < p.cols; col++) {
      if (rnd() < 0.18) continue; // randomized skips read as printed halftone
      ctx.beginPath();
      ctx.arc(p.x + col * p.gap, p.y + row * p.gap, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export interface ButterflyAccent {
  cx: number;
  cy: number;
  size: number;
  angle: number;
  alpha: number;
  /** Flat tint; omit for the original brand gradient fill. */
  tint?: string;
  /** true = sticker sits on top of the photos (and panel), like a real collage. */
  above?: boolean;
}

let cachedButterfly: Image | null | undefined;

async function loadButterfly(): Promise<Image | null> {
  if (cachedButterfly !== undefined) return cachedButterfly;
  try {
    const svg = readFileSync(fileURLToPath(new URL("../../assets/brand/butterfly-logo.svg", import.meta.url)), "utf8");
    const png = new Resvg(svg, { fitTo: { mode: "width", value: 600 } }).render().asPng();
    cachedButterfly = await loadImage(Buffer.from(png));
  } catch {
    cachedButterfly = null;
  }
  return cachedButterfly;
}

/** Rasterized brand butterfly as a standalone PNG (for satori headers). */
export async function butterflyPng(width: number, tint?: string): Promise<Buffer | null> {
  const img = await loadButterfly();
  if (!img) return null;
  const h = Math.round((img.height / img.width) * width);
  const canvas = createCanvas(width, h) as Canvas;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, h);
  if (tint) {
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, width, h);
  }
  return canvas.toBuffer("image/png");
}

/* ------------------------------------------------------------------ */
/* The collage layer                                                   */
/* ------------------------------------------------------------------ */

/** Torn white paper sheet baked into the collage (the wine variant's letter). */
export interface PaperPanel {
  x: number;
  y: number;
  w: number;
  h: number;
  paper: string;
  tearAmp?: number;
}

/** Soft light blob blended over the photos (lens-flare / film-light wash). */
export interface Flare {
  cx: number;
  cy: number;
  r: number;
  color: string;
  alpha: number;
}

export interface CollageSpec {
  slots: PhotoSlot[];
  dots: DotPatch[];
  butterflies: ButterflyAccent[];
  cutout: Partial<CutoutStyle>;
  /** Drawn AFTER photos so the sheet overlaps their edges; text goes on top in satori. */
  panel?: PaperPanel;
  flares?: Flare[];
}

/**
 * Compose photos + accents into one transparent full-card PNG. Photos map to
 * slots in order; extra slots are dropped so 1–2 photo profiles still render.
 */
export async function buildCollageLayer(
  photos: Buffer[],
  spec: CollageSpec,
  seed: string,
): Promise<Buffer> {
  const rnd = seededRng(seed);
  const canvas = createCanvas(CARD_W, CARD_H) as Canvas;
  const ctx = canvas.getContext("2d");
  const style: CutoutStyle = {
    paper: "#FFFFFF",
    border: 16,
    tearAmp: 11,
    shadow: "rgba(17,17,17,0.32)",
    focusY: 0.1,
    ...spec.cutout,
  };

  const butterfly = await loadButterfly();
  const stampButterfly = (acc: ButterflyAccent) => {
    if (!butterfly) return;
    const h = (butterfly.height / butterfly.width) * acc.size;
    let stamp: Canvas | Image = butterfly;
    if (acc.tint) {
      const tinted = createCanvas(Math.ceil(acc.size), Math.ceil(h)) as Canvas;
      const tctx = tinted.getContext("2d");
      tctx.drawImage(butterfly, 0, 0, acc.size, h);
      tctx.globalCompositeOperation = "source-in";
      tctx.fillStyle = acc.tint;
      tctx.fillRect(0, 0, acc.size, h);
      stamp = tinted;
    }
    ctx.save();
    ctx.translate(acc.cx, acc.cy);
    ctx.rotate((acc.angle * Math.PI) / 180);
    ctx.globalAlpha = acc.alpha;
    ctx.drawImage(stamp, -acc.size / 2, -h / 2, acc.size, h);
    ctx.restore();
  };

  for (const acc of spec.butterflies) if (!acc.above) stampButterfly(acc);
  for (const patch of spec.dots) drawDots(ctx, patch, rnd);

  const images = await Promise.all(
    photos.slice(0, spec.slots.length).map(async (buf) => {
      try {
        return await loadImage(buf);
      } catch {
        return null;
      }
    }),
  );
  images.forEach((img, i) => {
    if (!img) return;
    const slot = spec.slots[i]!;
    const cutout = buildCutout(
      img,
      slot.w,
      slot.h,
      {
        ...style,
        tearAmp: slot.straight ? 0 : style.tearAmp,
        border: slot.border ?? style.border,
        focusY: slot.focusY ?? style.focusY,
      },
      rnd,
    );
    if (slot.tint) applyTint(cutout.getContext("2d"), slot.w, slot.h, slot.tint);
    ctx.save();
    ctx.translate(slot.cx, slot.cy);
    ctx.rotate((slot.angle * Math.PI) / 180);
    ctx.shadowColor = style.shadow;
    ctx.shadowBlur = 34;
    ctx.shadowOffsetY = 16;
    ctx.drawImage(cutout, -slot.w / 2, -slot.h / 2);
    ctx.restore();
  });

  for (const f of spec.flares ?? []) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = f.alpha;
    const grad = ctx.createRadialGradient(f.cx, f.cy, 0, f.cx, f.cy, f.r);
    const [r, g, b] = hexRgb(f.color);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(f.cx - f.r, f.cy - f.r, f.r * 2, f.r * 2);
    ctx.restore();
  }

  if (spec.panel) {
    const p = spec.panel;
    const sheet = tornPolygon(p.w, p.h, p.tearAmp ?? 14, 30, rnd);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.shadowColor = style.shadow;
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 18;
    tracePolygon(ctx, sheet);
    ctx.fillStyle = p.paper;
    ctx.fill();
    ctx.restore();
  }

  for (const acc of spec.butterflies) if (acc.above) stampButterfly(acc);

  return canvas.toBuffer("image/png");
}

/**
 * Depth-pop layer: the person cutout (background-removed alpha PNG of the SAME
 * source photo as `slot`) drawn with the slot's exact cover transform, on a
 * transparent full-card canvas. Stacked ABOVE the text panel in the template,
 * it makes the person "lean out" of their photo over the panel — where the
 * panel does not overlap the photo, the pixels coincide with the base layer,
 * so only the overlap reads as 3D.
 *
 * Meant for straight border-0 slots (the mosaic hero). Returns null on decode
 * failure so callers simply skip the effect.
 */
export async function buildPopoutLayer(cutout: Buffer, slot: PhotoSlot): Promise<Buffer | null> {
  try {
    const img = await loadImage(cutout);
    const canvas = createCanvas(CARD_W, CARD_H) as Canvas;
    const ctx = canvas.getContext("2d");
    ctx.translate(slot.cx, slot.cy);
    ctx.rotate((slot.angle * Math.PI) / 180);
    coverDraw(ctx, img, -slot.w / 2, -slot.h / 2, slot.w, slot.h, slot.focusY ?? 0.24);
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}
