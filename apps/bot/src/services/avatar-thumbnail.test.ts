import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import { toAvatarThumbnail } from "./avatar-thumbnail.js";

/** A JPEG of `w × h` with enough detail that it does not compress to nothing. */
function photo(w: number, h: number): Buffer {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  for (let x = 0; x < w; x += 8) {
    for (let y = 0; y < h; y += 8) {
      ctx.fillStyle = `rgb(${(x * 7) % 256},${(y * 11) % 256},${(x + y) % 256})`;
      ctx.fillRect(x, y, 8, 8);
    }
  }
  return canvas.toBuffer("image/jpeg", 92);
}

describe("toAvatarThumbnail", () => {
  it("shrinks a full-size profile photo to the avatar ceiling", async () => {
    const original = photo(1280, 1600);
    const thumb = await toAvatarThumbnail(original);

    const image = await loadImage(thumb);
    expect(Math.max(image.width, image.height)).toBe(256);
    // The whole point: a 44px circle must not cost half a megabyte.
    expect(thumb.byteLength).toBeLessThan(original.byteLength / 4);
  });

  it("keeps the aspect ratio, so the circular crop still frames the face", async () => {
    const image = await loadImage(await toAvatarThumbnail(photo(1200, 1600)));
    expect(image.width / image.height).toBeCloseTo(0.75, 2);
  });

  it("does not upscale a photo that is already small", async () => {
    const image = await loadImage(await toAvatarThumbnail(photo(64, 64)));
    expect(image.width).toBe(64);
    expect(image.height).toBe(64);
  });

  it("returns the original bytes rather than nothing when decoding fails", async () => {
    // An avatar is worth showing at any size; a decoder that chokes on one
    // image must not turn a working screen into a broken one.
    const garbage = Buffer.from("not an image at all");
    await expect(toAvatarThumbnail(garbage)).resolves.toBe(garbage);
  });
});
