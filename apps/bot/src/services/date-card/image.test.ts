import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { toPngBuffer } from "./image.js";

describe("toPngBuffer", () => {
  it("re-encodes a JPEG to a real PNG (honest mime for satori data URIs)", async () => {
    const c = createCanvas(64, 64);
    c.getContext("2d").fillRect(0, 0, 64, 64);
    const jpeg = c.toBuffer("image/jpeg");
    expect(jpeg.subarray(0, 3).toString("hex")).toBe("ffd8ff"); // JPEG magic

    const png = await toPngBuffer(jpeg);
    expect(png).toBeInstanceOf(Buffer);
    expect(png!.subarray(0, 4).toString("hex")).toBe("89504e47"); // PNG magic
  });

  it("returns null for undecodable bytes", async () => {
    expect(await toPngBuffer(Buffer.from("not an image"))).toBeNull();
  });
});
