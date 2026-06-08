import { describe, it, expect } from "vitest";
import { sniffImageMime } from "./image-sniff.js";

function withHeader(bytes: number[], totalLen = 16): Buffer {
  const buf = Buffer.alloc(totalLen);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes[i]!;
  return buf;
}

describe("sniffImageMime", () => {
  it("detects JPEG", () => {
    expect(sniffImageMime(withHeader([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    expect(
      sniffImageMime(withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
  });

  it("detects GIF", () => {
    expect(sniffImageMime(withHeader([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
  });

  it("detects WebP (RIFF....WEBP)", () => {
    const buf = withHeader([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageMime(buf)).toBe("image/webp");
  });

  it("detects HEIC (ftyp + heic brand)", () => {
    const buf = withHeader([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(sniffImageMime(buf)).toBe("image/heic");
  });

  it("rejects an SVG / text payload masquerading as an image", () => {
    expect(sniffImageMime(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\">"))).toBeNull();
  });

  it("rejects a too-short buffer", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("rejects arbitrary bytes", () => {
    expect(sniffImageMime(withHeader([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});
