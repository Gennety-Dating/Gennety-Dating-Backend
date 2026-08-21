import { describe, expect, it, vi } from "vitest";
import { validateVoicePrompt } from "./voice-prompt-validation.js";

const AUDIO = Buffer.from("fake-opus-bytes");

function deps(over: Partial<Parameters<typeof validateVoicePrompt>[1]> = {}) {
  return {
    transcribe: vi.fn(async () => ({ ok: true as const, text: "мне нравится варить кофе по утрам" })),
    moderateText: vi.fn(async () => ({ ok: true as const, signals: [] })),
    computePeaks: vi.fn(async () => [10, 20, 30]),
    ...over,
  };
}

describe("validateVoicePrompt", () => {
  it("accepts a clip that passes every check", async () => {
    const result = await validateVoicePrompt(
      { audio: AUDIO, durationSeconds: 14 },
      deps(),
    );
    expect(result).toEqual({
      ok: true,
      value: { transcript: "мне нравится варить кофе по утрам", waveform: [10, 20, 30] },
    });
  });

  it("rejects a mis-held mic button WITHOUT paying a provider", async () => {
    const d = deps();
    const result = await validateVoicePrompt({ audio: AUDIO, durationSeconds: 1 }, d);
    expect(result).toMatchObject({ ok: false, reason: "voice_too_short", retryable: true });
    expect(d.transcribe).not.toHaveBeenCalled();
    expect(d.moderateText).not.toHaveBeenCalled();
  });

  it("rejects an over-long clip before transcription too", async () => {
    const d = deps();
    const result = await validateVoicePrompt({ audio: AUDIO, durationSeconds: 120 }, d);
    expect(result).toMatchObject({ ok: false, reason: "voice_too_long" });
    expect(d.transcribe).not.toHaveBeenCalled();
  });

  it("rejects unsafe speech", async () => {
    const result = await validateVoicePrompt(
      { audio: AUDIO, durationSeconds: 12 },
      deps({
        moderateText: vi.fn(async () => ({
          ok: true as const,
          signals: [
            { provider: "openai" as const, category: "violence", score: 0.9, severity: "block" as const },
          ],
        })),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "unsafe_content", retryable: false });
  });

  it("rejects a clip that hands out a way to message the speaker off-platform", async () => {
    const result = await validateVoicePrompt(
      { audio: AUDIO, durationSeconds: 12 },
      deps({
        transcribe: vi.fn(async () => ({
          ok: true as const,
          text: "привет, если что напиши мне в телеграм",
        })),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "audio_contact_info" });
  });

  describe("a provider that cannot answer is retryable, never a verdict on the user", () => {
    it("when transcription fails", async () => {
      const result = await validateVoicePrompt(
        { audio: AUDIO, durationSeconds: 12 },
        deps({ transcribe: vi.fn(async () => ({ ok: false as const, error: "timeout" as const })) }),
      );
      expect(result).toMatchObject({ ok: false, reason: "processing_unavailable", retryable: true });
    });

    it("when moderation is unavailable", async () => {
      const result = await validateVoicePrompt(
        { audio: AUDIO, durationSeconds: 12 },
        deps({ moderateText: vi.fn(async () => ({ ok: false as const, error: "api" as const })) }),
      );
      expect(result).toMatchObject({ ok: false, reason: "processing_unavailable", retryable: true });
    });

    it("when the transcript comes back empty — we do not publish audio we could not read", async () => {
      const result = await validateVoicePrompt(
        { audio: AUDIO, durationSeconds: 12 },
        deps({ transcribe: vi.fn(async () => ({ ok: true as const, text: "   " })) }),
      );
      expect(result).toMatchObject({ ok: false, reason: "processing_unavailable", retryable: true });
    });
  });

  it("accepts the clip when only the waveform could not be computed", async () => {
    const result = await validateVoicePrompt(
      { audio: AUDIO, durationSeconds: 12 },
      deps({ computePeaks: vi.fn(async () => null) }),
    );
    expect(result).toMatchObject({ ok: true, value: { waveform: [] } });
  });
});
