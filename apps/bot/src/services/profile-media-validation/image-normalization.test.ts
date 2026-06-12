import { describe, expect, it } from "vitest";
import { sniffImageMime } from "./image-normalization.js";

describe("sniffImageMime", () => {
  it("recognizes supported image signatures", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(
      sniffImageMime(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(sniffImageMime(Buffer.from("RIFFxxxxWEBP"))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("xxxxftypheic"))).toBe("image/heic");
  });

  it("rejects text and spoofed files", () => {
    expect(sniffImageMime(Buffer.from("not-an-image"))).toBeNull();
  });
});
