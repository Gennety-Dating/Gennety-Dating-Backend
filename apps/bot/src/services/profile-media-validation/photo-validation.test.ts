import { describe, expect, it, vi } from "vitest";
import type { DetectedFace } from "./types.js";
import {
  validateProfilePhoto,
  type PhotoValidationDeps,
} from "./photo-validation.js";

const clearFace: DetectedFace = {
  confidence: 0.99,
  boundingBox: { left: 0.2, top: 0.1, width: 0.35, height: 0.5 },
  brightness: 0.6,
  sharpness: 0.8,
  pitch: 0,
  roll: 0,
  yaw: 0,
};
const candidateJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);

function deps(overrides: Partial<PhotoValidationDeps> = {}): PhotoValidationDeps {
  return {
    fingerprintImage: vi.fn(async (buffer: Buffer) => ({
      sha256: buffer.toString(),
      differenceHash:
        buffer.toString() === "existing"
          ? "0000000000000000"
          : "ffffffffffffffff",
    })),
    normalizeImage: vi.fn(async (buffer: Buffer) => buffer),
    moderateWithOpenAI: vi.fn(async () => ({
      ok: true as const,
      signals: [],
    })),
    moderateWithAws: vi.fn(async () => ({
      ok: true as const,
      signals: [],
    })),
    detectFaces: vi.fn(async () => ({
      ok: true as const,
      faces: [clearFace],
    })),
    compareFaces: vi.fn(async () => ({
      ok: true as const,
      faceFound: true,
      similarity: 0.94,
    })),
    ...overrides,
  };
}

describe("validateProfilePhoto", () => {
  it("rejects a spoofed non-image before provider calls", async () => {
    const testDeps = deps();
    const result = await validateProfilePhoto(
      { candidate: Buffer.from("not-an-image"), mime: "image/jpeg" },
      { deps: testDeps },
    );
    expect(result).toEqual({
      ok: false,
      reason: "invalid_media",
      retryable: false,
    });
    expect(testDeps.normalizeImage).not.toHaveBeenCalled();
  });

  it("accepts the first safe one-person photo as the identity anchor", async () => {
    const result = await validateProfilePhoto(
      { candidate: candidateJpeg, mime: "image/jpeg" },
      { deps: deps() },
    );
    expect(result).toMatchObject({
      ok: true,
      value: { identitySimilarity: null },
    });
  });

  it("rejects exact and perceptual duplicates before provider calls", async () => {
    const exactDeps = deps({
      fingerprintImage: vi.fn(async () => ({
        sha256: "same",
        differenceHash: "0000000000000000",
      })),
    });
    const exact = await validateProfilePhoto(
      {
        candidate: candidateJpeg,
        mime: "image/jpeg",
        existingPhotos: [{ buffer: Buffer.from("existing") }],
      },
      { deps: exactDeps },
    );
    expect(exact).toMatchObject({ ok: false, reason: "duplicate_exact" });
    expect(exactDeps.moderateWithAws).not.toHaveBeenCalled();

    const nearDeps = deps({
      fingerprintImage: vi
        .fn()
        .mockResolvedValueOnce({
          sha256: "candidate",
          differenceHash: "000000000000000f",
        })
        .mockResolvedValueOnce({
          sha256: "existing",
          differenceHash: "0000000000000000",
        }),
    });
    const near = await validateProfilePhoto(
      {
        candidate: candidateJpeg,
        mime: "image/jpeg",
        existingPhotos: [{ buffer: Buffer.from("existing") }],
      },
      { deps: nearDeps },
    );
    expect(near).toMatchObject({ ok: false, reason: "duplicate_near" });
  });

  it("uses the configured pHash distance for duplicate detection", async () => {
    const result = await validateProfilePhoto(
      {
        candidate: candidateJpeg,
        mime: "image/jpeg",
        existingPhotoHashes: ["0000000000000000"],
      },
      {
        deps: deps({
          fingerprintImage: vi.fn(async () => ({
            sha256: "candidate",
            differenceHash: "00000000000000ff",
          })),
        }),
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "duplicate_near" });
  });

  it("rejects unsafe content and provider outages fail closed", async () => {
    const unsafe = await validateProfilePhoto(
      { candidate: candidateJpeg, mime: "image/jpeg" },
      {
        deps: deps({
          moderateWithAws: vi.fn(async () => ({
            ok: true as const,
            signals: [
              {
                provider: "aws" as const,
                category: "Explicit Nudity",
                score: 0.99,
                severity: "block" as const,
              },
            ],
          })),
        }),
      },
    );
    expect(unsafe).toMatchObject({ ok: false, reason: "unsafe_content" });

    const outage = await validateProfilePhoto(
      { candidate: candidateJpeg, mime: "image/jpeg" },
      {
        deps: deps({
          moderateWithOpenAI: vi.fn(async () => ({
            ok: false as const,
            error: "timeout" as const,
          })),
        }),
      },
    );
    expect(outage).toEqual({
      ok: false,
      reason: "processing_unavailable",
      retryable: true,
    });
  });

  it("requires at least one usable face and allows group photos", async () => {
    const none = await validateProfilePhoto(
      { candidate: candidateJpeg, mime: "image/jpeg" },
      {
        deps: deps({
          detectFaces: vi.fn(async () => ({
            ok: true as const,
            faces: [],
          })),
        }),
      },
    );
    expect(none).toMatchObject({ ok: false, reason: "no_face" });

    const group = await validateProfilePhoto(
      { candidate: candidateJpeg, mime: "image/jpeg" },
      {
        deps: deps({
          detectFaces: vi.fn(async () => ({
            ok: true as const,
            faces: [clearFace, clearFace],
          })),
        }),
      },
    );
    expect(group).toMatchObject({ ok: true });
  });

  it("rejects a different person and accepts matches at the configured threshold", async () => {
    const mismatch = await validateProfilePhoto(
      {
        candidate: candidateJpeg,
        mime: "image/jpeg",
        identityReference: Buffer.from("reference"),
      },
      {
        deps: deps({
          compareFaces: vi.fn(async () => ({
            ok: true as const,
            faceFound: true,
            similarity: 0.4,
          })),
        }),
      },
    );
    expect(mismatch).toMatchObject({
      ok: false,
      reason: "identity_mismatch",
    });

    const match = await validateProfilePhoto(
      {
        candidate: candidateJpeg,
        mime: "image/jpeg",
        identityReference: Buffer.from("reference"),
      },
      {
        deps: deps({
          compareFaces: vi.fn(async () => ({
            ok: true as const,
            faceFound: true,
            similarity: 0.8,
          })),
        }),
      },
    );
    expect(match).toMatchObject({
      ok: true,
      value: { identitySimilarity: 0.8 },
    });
  });
});
