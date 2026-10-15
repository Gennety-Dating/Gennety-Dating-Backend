import { describe, expect, it, vi } from "vitest";
import {
  FRAME_MODERATION_CONCURRENCY,
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

  describe("parallel moderation", () => {
    const withAudio = () =>
      vi.fn(async () => ({
        durationSeconds: 36,
        width: 720,
        height: 1280,
        videoCodec: "h264",
        hasAudio: true,
      }));
    const blockSignal = {
      provider: "aws" as const,
      category: "Explicit Nudity",
      score: 0.99,
      severity: "block" as const,
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("moderates frames several at a time, never more than the bound", async () => {
      let inFlight = 0;
      let peak = 0;
      const moderateImageAws = vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return { ok: true as const, signals: [] };
      });
      const result = await validateProfileVideo(
        { video: Buffer.from("video") },
        { deps: deps({ moderateImageAws }) },
      );
      expect(result.ok).toBe(true);
      expect(moderateImageAws).toHaveBeenCalledTimes(12);
      expect(peak).toBe(FRAME_MODERATION_CONCURRENCY);
    });

    it("still rejects a blocked frame in the middle, and stops launching new checks", async () => {
      const moderateImageAws = vi.fn(async (frame: Buffer) => {
        await tick();
        return {
          ok: true as const,
          signals: frame.toString() === "frame-2" ? [blockSignal] : [],
        };
      });
      const result = await validateProfileVideo(
        { video: Buffer.from("video") },
        { deps: deps({ moderateImageAws }) },
      );
      expect(result).toEqual({ ok: false, reason: "unsafe_content", retryable: false });
      // frame-2 is in the first wave; once it is back, at most the remaining
      // workers' current frames finish — the tail is never sent.
      expect(moderateImageAws.mock.calls.length).toBeLessThan(12);
    });

    it("prefers unsafe over unavailable when both come back from frames in flight", async () => {
      const result = await validateProfileVideo(
        { video: Buffer.from("video") },
        {
          deps: deps({
            // frame-0 (first in order) is unavailable, frame-3 is blocked:
            // the one-by-one loop said "unavailable", now unsafe wins.
            moderateImageOpenAI: vi.fn(async (frame: Buffer) =>
              frame.toString() === "frame-0"
                ? { ok: false as const, error: "timeout" as const }
                : { ok: true as const, signals: [] },
            ),
            moderateImageAws: vi.fn(async (frame: Buffer) => ({
              ok: true as const,
              signals: frame.toString() === "frame-3" ? [blockSignal] : [],
            })),
          }),
        },
      );
      expect(result).toEqual({ ok: false, reason: "unsafe_content", retryable: false });
    });

    it("treats a frame check that throws as unavailable, not as safe", async () => {
      const result = await validateProfileVideo(
        { video: Buffer.from("video") },
        {
          deps: deps({
            moderateImageAws: vi.fn(async (frame: Buffer) => {
              if (frame.toString() === "frame-7") throw new Error("sdk bug");
              return { ok: true as const, signals: [] };
            }),
          }),
        },
      );
      expect(result).toEqual({
        ok: false,
        reason: "processing_unavailable",
        retryable: true,
      });
    });

    it("starts the audio branch without waiting for the frames", async () => {
      let releaseFrames!: () => void;
      const framesGate = new Promise<void>((resolve) => {
        releaseFrames = resolve;
      });
      const transcribeAudio = vi.fn(async () => ({ ok: true as const, text: "hi" }));
      const moderateImageAws = vi.fn(async () => {
        await framesGate;
        return { ok: true as const, signals: [] };
      });
      const pending = validateProfileVideo(
        { video: Buffer.from("video") },
        { deps: deps({ probe: withAudio(), transcribeAudio, moderateImageAws }) },
      );
      // No frame has answered, and the transcript is already requested.
      await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledOnce());
      expect(moderateImageAws).toHaveBeenCalled();
      releaseFrames();
      expect((await pending).ok).toBe(true);
    });

    it("rejects unsafe audio even when every frame is safe", async () => {
      const result = await validateProfileVideo(
        { video: Buffer.from("video") },
        {
          deps: deps({
            probe: withAudio(),
            moderateText: vi.fn(async () => ({
              ok: true as const,
              signals: [{ ...blockSignal, provider: "openai" as const, category: "sexual" }],
            })),
          }),
        },
      );
      expect(result).toEqual({ ok: false, reason: "unsafe_content", retryable: false });
    });

    it("rejects unsafe audio even when a frame provider was unavailable", async () => {
      const result = await validateProfileVideo(
        { video: Buffer.from("video") },
        {
          deps: deps({
            probe: withAudio(),
            moderateImageOpenAI: vi.fn(async () => ({
              ok: false as const,
              error: "timeout" as const,
            })),
            moderateText: vi.fn(async () => ({
              ok: true as const,
              signals: [{ ...blockSignal, provider: "openai" as const, category: "sexual" }],
            })),
          }),
        },
      );
      expect(result).toEqual({ ok: false, reason: "unsafe_content", retryable: false });
    });

    it("is unavailable when only the audio branch cannot answer", async () => {
      const result = await validateProfileVideo(
        { video: Buffer.from("video") },
        {
          deps: deps({
            probe: withAudio(),
            transcribeAudio: vi.fn(async () => ({
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

    it("is unavailable when only the frame branch cannot answer", async () => {
      const result = await validateProfileVideo(
        { video: Buffer.from("video") },
        {
          deps: deps({
            probe: withAudio(),
            extractFrames: vi.fn(async () => {
              throw new Error("ffmpeg died");
            }),
          }),
        },
      );
      expect(result).toEqual({
        ok: false,
        reason: "processing_unavailable",
        retryable: true,
      });
    });

    it("skips the transcript once a frame already rejected the clip", async () => {
      let releaseAudio!: () => void;
      const audioGate = new Promise<void>((resolve) => {
        releaseAudio = resolve;
      });
      const transcribeAudio = vi.fn(async () => ({ ok: true as const, text: "" }));
      const pending = validateProfileVideo(
        { video: Buffer.from("video") },
        {
          deps: deps({
            probe: withAudio(),
            extractAudio: vi.fn(async () => {
              await audioGate;
              return Buffer.from("audio");
            }),
            transcribeAudio,
            moderateImageAws: vi.fn(async () => ({
              ok: true as const,
              signals: [blockSignal],
            })),
          }),
        },
      );
      await tick();
      releaseAudio();
      expect(await pending).toEqual({
        ok: false,
        reason: "unsafe_content",
        retryable: false,
      });
      expect(transcribeAudio).not.toHaveBeenCalled();
    });
  });
});
