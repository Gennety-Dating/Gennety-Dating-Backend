import { createCanvas, loadImage } from "@napi-rs/canvas";

/**
 * Shrink a profile photo to avatar size.
 *
 * The Date Ticket Mini App draws two 44px circles on the "pay for us both"
 * button and streams the participants' FULL profile photos to fill them — half
 * a megabyte each, measured on the live demo (517 KB + 355 KB for one button).
 * That is ~850 KB of mobile data fetched inside a Telegram WebView before the
 * button is complete, against the client's 6-second preload budget: on a slow
 * link the budget expires, the screen renders, and the two avatars are still in
 * flight. What the user sees is a pay button with two broken images on it, and
 * the reasonable reading of that is "the photos didn't load".
 *
 * 256px is 2× the largest avatar the Mini App draws (64px on the reveal card)
 * at a 2× device pixel ratio, so it is still sharp on a retina phone while
 * costing roughly 5% of the bytes. Photos already smaller than that are re-
 * encoded rather than upscaled — a 44px circle has nothing to gain from more
 * pixels, and re-encoding a small source is cheap.
 *
 * Failure returns the original bytes rather than nothing: an avatar is worth
 * showing at any size, and a decoder that chokes on one image must not turn a
 * working screen into a broken one.
 */

const MAX_EDGE = 256;
const JPEG_QUALITY = 82;

export async function toAvatarThumbnail(bytes: Buffer): Promise<Buffer> {
  try {
    const image = await loadImage(bytes);
    const { width, height } = image;
    if (!width || !height) return bytes;

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, w, h);
    return canvas.toBuffer("image/jpeg", JPEG_QUALITY);
  } catch {
    return bytes;
  }
}
