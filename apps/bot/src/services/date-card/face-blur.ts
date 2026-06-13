import {
  createCanvas,
  loadImage,
  type Canvas,
  type SKRSContext2D,
} from "@napi-rs/canvas";
import { detectFaces } from "../face-match.js";

/**
 * Blur the face(s) in a profile photo so the image can safely leave the
 * platform on a shareable date card (PRODUCT_SPEC.md §3.7).
 *
 * Privacy is the priority, so the failure modes are deliberately fail-*safe*
 * (toward more obscuring, never toward leaking a clear face):
 *   - Faces detected   → pixelate each detected face box (padded for hairline/chin).
 *   - No face / provider off / detection error → pixelate the WHOLE image.
 *   - Image can't even be decoded → return `null`; the caller must NOT send a
 *     share card it couldn't blur.
 *
 * Pixelation (downscale → upscale with smoothing off) is used instead of a
 * Gaussian blur because it is irreversible-looking, cheap, and renders
 * identically across platforms.
 */
export async function blurFacesInPhoto(buffer: Buffer): Promise<Buffer | null> {
  let img;
  try {
    img = await loadImage(buffer);
  } catch {
    return null; // can't decode → never risk sending the clear original
  }

  try {
    const w = img.width;
    const h = img.height;
    const canvas = createCanvas(w, h) as Canvas;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    const detection = await detectFaces(buffer);
    const boxes =
      detection.ok && detection.faces.length > 0
        ? detection.faces.map((f) => f.boundingBox).filter((b) => b != null)
        : [];

    if (boxes.length === 0) {
      // No face geometry available — obscure everything rather than guess.
      pixelateRegion(ctx, canvas, 0, 0, w, h);
    } else {
      const pad = 0.18; // expand each box to cover hairline / chin / ears
      for (const b of boxes) {
        let x = (b!.left - b!.width * pad) * w;
        let y = (b!.top - b!.height * pad) * h;
        let bw = b!.width * (1 + pad * 2) * w;
        let bh = b!.height * (1 + pad * 2) * h;
        x = Math.max(0, Math.round(x));
        y = Math.max(0, Math.round(y));
        bw = Math.min(w - x, Math.round(bw));
        bh = Math.min(h - y, Math.round(bh));
        if (bw > 0 && bh > 0) pixelateRegion(ctx, canvas, x, y, bw, bh);
      }
    }

    return canvas.toBuffer("image/png");
  } catch {
    return null; // any drawing failure → caller aborts the share send
  }
}

/**
 * Pixelate a rectangular region in place by sampling it into a tiny canvas and
 * stretching it back with image smoothing disabled. `blocksAcross` controls the
 * coarseness (smaller = blockier / more private).
 */
function pixelateRegion(
  ctx: SKRSContext2D,
  source: Canvas,
  x: number,
  y: number,
  w: number,
  h: number,
  blocksAcross = 10,
): void {
  const sw = Math.max(1, blocksAcross);
  const sh = Math.max(1, Math.round(blocksAcross * (h / w)));
  const tmp = createCanvas(sw, sh) as Canvas;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(source, x, y, w, h, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}
