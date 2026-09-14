import { describe, expect, it, vi } from "vitest";
import { transcribeVideoAudio } from "./audio-transcription.js";

const AUDIO = Buffer.from("fake-audio-bytes");

function whisperReturning(payload: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function responseFormat(fetchFn: ReturnType<typeof whisperReturning>): ReturnType<FormData["get"]> {
  const init = fetchFn.mock.calls[0]![1];
  return (init?.body as FormData).get("response_format");
}

describe("transcribeVideoAudio", () => {
  // Audit A13-L14: the voice prompt needs the length Whisper decoded, because
  // the client's own `durationSec` is only a claim.
  it("reports Whisper's measured duration when asked for it", async () => {
    const fetchFn = whisperReturning({ text: " hello there ", duration: 17.36 });

    const result = await transcribeVideoAudio(AUDIO, {
      apiKey: "sk-test",
      fetchFn,
      withDuration: true,
    });

    expect(result).toEqual({ ok: true, text: "hello there", durationSeconds: 17.36 });
    expect(responseFormat(fetchFn)).toBe("verbose_json");
  });

  it("keeps the plain response, and no duration, for callers that did not ask", async () => {
    const fetchFn = whisperReturning({ text: "hello" });

    const result = await transcribeVideoAudio(AUDIO, { apiKey: "sk-test", fetchFn });

    expect(result).toEqual({ ok: true, text: "hello" });
    expect(responseFormat(fetchFn)).toBe("json");
  });

  it("omits a duration it cannot trust rather than passing it on", async () => {
    for (const duration of ["17", -3, Number.NaN, null]) {
      const result = await transcribeVideoAudio(AUDIO, {
        apiKey: "sk-test",
        fetchFn: whisperReturning({ text: "hello", duration }),
        withDuration: true,
      });
      expect(result).toEqual({ ok: true, text: "hello" });
    }
  });
});
