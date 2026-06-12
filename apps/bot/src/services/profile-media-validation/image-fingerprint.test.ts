import { describe, expect, it } from "vitest";
import {
  classifyDuplicate,
  differenceHashFromGrayscale,
  fingerprintImage,
  hammingDistance64,
} from "./image-fingerprint.js";

function gradient(reverse = false): Buffer {
  const pixels = Buffer.alloc(9 * 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      pixels[y * 9 + x] = reverse ? 255 - x * 20 : x * 20;
    }
  }
  return pixels;
}

describe("image fingerprints", () => {
  it("builds a stable 64-bit difference hash", () => {
    expect(differenceHashFromGrayscale(gradient())).toBe("0000000000000000");
    expect(differenceHashFromGrayscale(gradient(true))).toBe(
      "ffffffffffffffff",
    );
  });

  it("calculates Hamming distance", () => {
    expect(
      hammingDistance64("0000000000000000", "000000000000000f"),
    ).toBe(4);
  });

  it("fingerprints exact bytes plus normalized pixels", async () => {
    const normalized = gradient();
    const first = await fingerprintImage(Buffer.from("photo-a"), {
      normalizeToGrayscale: async () => normalized,
    });
    const second = await fingerprintImage(Buffer.from("photo-a"), {
      normalizeToGrayscale: async () => normalized,
    });

    expect(first).toEqual(second);
    expect(first.sha256).toHaveLength(64);
    expect(first.differenceHash).toHaveLength(16);
  });

  it("classifies exact, near, ambiguous, and distinct pairs", () => {
    const base = {
      sha256: "a",
      differenceHash: "0000000000000000",
    };

    expect(classifyDuplicate(base, base)).toEqual({
      kind: "exact",
      distance: 0,
    });
    expect(
      classifyDuplicate(base, {
        sha256: "b",
        differenceHash: "000000000000000f",
      }),
    ).toEqual({ kind: "near", distance: 4 });
    expect(
      classifyDuplicate(base, {
        sha256: "c",
        differenceHash: "00000000000001ff",
      }),
    ).toEqual({ kind: "ambiguous", distance: 9 });
    expect(
      classifyDuplicate(base, {
        sha256: "d",
        differenceHash: "000000000000ffff",
      }),
    ).toEqual({ kind: "distinct", distance: 16 });
  });

  it("rejects malformed difference hashes", () => {
    expect(() => hammingDistance64("bad", "0000000000000000")).toThrow(
      /16 hexadecimal/,
    );
  });
});
