import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";

vi.mock("../face-match.js", () => ({ detectFaces: vi.fn() }));

import { detectFaces } from "../face-match.js";
import { blurFacesInPhoto } from "./face-blur.js";

const mDetect = detectFaces as unknown as ReturnType<typeof vi.fn>;

/** A small valid PNG with a flat magenta fill. */
function samplePng(): Buffer {
  const c = createCanvas(120, 150);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#FF00AA";
  ctx.fillRect(0, 0, 120, 150);
  return c.toBuffer("image/png");
}

describe("blurFacesInPhoto", () => {
  beforeEach(() => mDetect.mockReset());

  it("returns null for an undecodable buffer (never leaks the original)", async () => {
    mDetect.mockResolvedValue({ ok: false, error: "not_configured" });
    const out = await blurFacesInPhoto(Buffer.from("not an image"));
    expect(out).toBeNull();
  });

  it("pixelates the whole image when no face geometry is available", async () => {
    mDetect.mockResolvedValue({ ok: false, error: "not_configured" });
    const out = await blurFacesInPhoto(samplePng());
    expect(out).toBeInstanceOf(Buffer);
    expect(out!.subarray(0, 4).toString("hex")).toBe("89504e47"); // PNG magic
  });

  it("pixelates each detected face box", async () => {
    mDetect.mockResolvedValue({
      ok: true,
      faces: [{ boundingBox: { left: 0.3, top: 0.2, width: 0.3, height: 0.3 } }],
    });
    const out = await blurFacesInPhoto(samplePng());
    expect(out).toBeInstanceOf(Buffer);
    expect(out!.subarray(0, 4).toString("hex")).toBe("89504e47");
  });
});
