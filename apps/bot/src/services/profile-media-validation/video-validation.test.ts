import { describe, expect, it, vi } from "vitest";
import {
  buildOwnerEvidence,
  ownerEvidencePasses,
  validateProfileVideo,
  type VideoValidationDeps,
} from "./video-validation.js";
import type { VideoFrame } from "./types.js";

const frames: VideoFrame[] = Array.from({ length: 12 }, (_, index) => ({
  buffer: Buffer.from(`frame-${index}`),
  timestampSeconds: index * 3,
}));

function isOwnerFrame(frame: Buffer): boolean {
  return ["frame-1", "frame-5", "frame-9"].includes(frame.toString());
}

function deps(overrides: Partial<VideoValidationDeps> = {}): VideoValidationDeps {
  return {
    withTempDirectory: async (operation) => operation("/tmp/test-video"),
    writeFile: vi.fn(async () => {}),
    probe: vi.fn(async () => ({
      durationSeconds: 36,
      width: 720,
      height: 1280,
      videoCodec: "h264",
      hasAudio: false,
    })),
    extractFrames: vi.fn(async () => frames),
    extractAudio: vi.fn(async () => Buffer.from("audio")),
    moderateImageOpenAI: vi.fn(async () => ({
      ok: true as const,
      signals: [],
    })),
    moderateImageAws: vi.fn(async () => ({
      ok: true as const,
      signals: [],
    })),
    detectFaces: vi.fn(async (frame: Buffer) => ({
      ok: true as const,
      faces: isOwnerFrame(frame)
        ? [
            {
              confidence: 0.99,
              boundingBox: { left: 0.2, top: 0.2, width: 0.3, height: 0.4 },
              brightness: 0.5,
              sharpness: 0.8,
              pitch: 0,
              roll: 0,
              yaw: 0,
            },
          ]
        : [],
    })),
    compareFaces: vi.fn(async (_reference: Buffer, frame: Buffer) =>
      isOwnerFrame(frame)
        ? {
            ok: true as const,
            faceFound: true,
            similarity: 0.95,
            matchedFace: {
              confidence: 0.99,
              boundingBox: {
                left: 0.2,
                top: 0.2,
                width: 0.3,
                height: 0.4,
              },
            },
          }
        : {
            ok: true as const,
            faceFound: true,
            similarity: 0.1,
          },
    ),
    transcribeAudio: vi.fn(async () => ({
      ok: true as const,
      text: "",
    })),
    moderateText: vi.fn(async () => ({
      ok: true as const,
      signals: [],
    })),
    ...overrides,
  };
}

describe("video owner evidence", () => {
  it("passes distributed appearances without requiring 70% frame coverage", () => {
    const evidence = buildOwnerEvidence(
      [
        { timestampSeconds: 3, highQuality: true },
        { timestampSeconds: 15, highQuality: true },
        { timestampSeconds: 27, highQuality: true },
      ],
      36,
    );
    expect(evidence).toEqual({
      matchedFrameCount: 3,
      matchedClusterCount: 3,
      matchedTemporalThirds: 3,
      hasHighQualityMatch: true,
    });
    expect(ownerEvidencePasses(evidence, 36)).toBe(true);
  });

  it("rejects a brief owner cameo confined to one moment", () => {
    const evidence = buildOwnerEvidence(
      [
        { timestampSeconds: 1, highQuality: true },
        { timestampSeconds: 1.4, highQuality: true },
        { timestampSeconds: 1.8, highQuality: true },
      ],
      30,
    );
    expect(ownerEvidencePasses(evidence, 30)).toBe(false);
  });
});

describe("validateProfileVideo", () => {
  it("accepts a safe travel/group-style video with sparse owner frames", async () => {
    const result = await validateProfileVideo(
      {
        video: Buffer.from("video"),
        identityReference: Buffer.from("owner"),
      },
      { deps: deps() },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        evidence: {
          matchedFrameCount: 3,
          matchedClusterCount: 3,
        },
      },
    });
  });

  it("rejects scenery-only video", async () => {
    const result = await validateProfileVideo(
      {
        video: Buffer.from("video"),
        identityReference: Buffer.from("owner"),
      },
      {
        deps: deps({
          detectFaces: vi.fn(async () => ({
            ok: true as const,
            faces: [],
          })),
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "video_owner_missing",
    });
  });

  it("does not treat a blurry matched face as reliable owner evidence", async () => {
    const result = await validateProfileVideo(
      {
        video: Buffer.from("video"),
        identityReference: Buffer.from("owner"),
      },
      {
        deps: deps({
          detectFaces: vi.fn(async (frame: Buffer) => ({
            ok: true as const,
            faces: isOwnerFrame(frame)
              ? [
                  {
                    confidence: 0.99,
                    boundingBox: {
                      left: 0.2,
                      top: 0.2,
                      width: 0.3,
                      height: 0.4,
                    },
                    brightness: 0.5,
                    sharpness: 0.05,
                    pitch: 0,
                    roll: 0,
                    yaw: 0,
                  },
                ]
              : [],
          })),
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "video_owner_too_brief",
    });
  });

  it("rejects any unsafe sampled frame", async () => {
    const result = await validateProfileVideo(
      {
        video: Buffer.from("video"),
        identityReference: Buffer.from("owner"),
      },
      {
        deps: deps({
          moderateImageAws: vi.fn(async (frame: Buffer) => ({
            ok: true as const,
            signals: frame.toString() === "frame-4"
              ? [
                  {
                    provider: "aws" as const,
                    category: "Explicit Nudity",
                    score: 0.99,
                    severity: "block" as const,
                  },
                ]
              : [],
          })),
        }),
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "unsafe_content" });
  });

  it("moderates an audio transcript when an audio stream exists", async () => {
    const transcribeAudio = vi.fn(async () => ({
      ok: true as const,
      text: "unsafe transcript",
    }));
    const result = await validateProfileVideo(
      {
        video: Buffer.from("video"),
        identityReference: Buffer.from("owner"),
      },
      {
        deps: deps({
          probe: vi.fn(async () => ({
            durationSeconds: 36,
            width: 720,
            height: 1280,
            videoCodec: "h264",
            hasAudio: true,
          })),
          transcribeAudio,
          moderateText: vi.fn(async () => ({
            ok: true as const,
            signals: [
              {
                provider: "openai" as const,
                category: "sexual",
                score: 0.99,
                severity: "block" as const,
              },
            ],
          })),
        }),
      },
    );
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, reason: "unsafe_content" });
  });

  it("fails closed on a provider outage", async () => {
    const result = await validateProfileVideo(
      {
        video: Buffer.from("video"),
        identityReference: Buffer.from("owner"),
      },
      {
        deps: deps({
          moderateImageOpenAI: vi.fn(async () => ({
            ok: false as const,
            error: "timeout" as const,
          })),
        }),
      },
    );
    expect(result).toEqual({
      ok: false,
      reason: "processing_unavailable",
      retryable: true,
    });
  });
});
