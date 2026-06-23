import { describe, expect, it, vi } from "vitest";
import {
  validateProfileVideo,
  type VideoValidationDeps,
} from "./video-validation.js";
import type { VideoFrame } from "./types.js";

const frames: VideoFrame[] = Array.from({ length: 12 }, (_, index) => ({
  buffer: Buffer.from(`frame-${index}`),
  timestampSeconds: index * 3,
}));

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

describe("validateProfileVideo", () => {
  it("accepts a safe video regardless of whether the owner appears", async () => {
    // No identity gate anymore: a safe friends/scenery/party clip is fine even
    // if the profile owner is never on screen.
    const result = await validateProfileVideo(
      { video: Buffer.from("video") },
      { deps: deps() },
    );
    expect(result).toMatchObject({
      ok: true,
      value: { sampledFrameCount: 12, durationSeconds: 36 },
    });
  });

  it("rejects any unsafe sampled frame", async () => {
    const result = await validateProfileVideo(
      { video: Buffer.from("video") },
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
      { video: Buffer.from("video") },
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
      { video: Buffer.from("video") },
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
