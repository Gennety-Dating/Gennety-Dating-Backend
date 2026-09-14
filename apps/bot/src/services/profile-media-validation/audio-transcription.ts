import { env } from "../../config.js";
import type { ProviderError } from "./types.js";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = "whisper-1";

export type AudioTranscriptionResult =
  | {
      ok: true;
      text: string;
      /** Seconds of audio Whisper decoded. Only with `withDuration`, and only when reported. */
      durationSeconds?: number;
    }
  | { ok: false; error: ProviderError };

export interface AudioTranscriptionOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /**
   * Ask for `verbose_json`, which also reports how long the audio actually is
   * as Whisper decoded it — a measurement, where a client's `durationSec` is
   * only a claim (audit A13-L14). Same request, same price; off by default so
   * the video path's payload is unchanged.
   */
  withDuration?: boolean;
}

export async function transcribeVideoAudio(
  buffer: Buffer,
  options: AudioTranscriptionOptions = {},
): Promise<AudioTranscriptionResult> {
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "not_configured" };
  if (buffer.byteLength === 0) return { ok: false, error: "invalid_response" };

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: "audio/mpeg" }),
    "profile-video.mp3",
  );
  form.append("model", MODEL);
  form.append("response_format", options.withDuration ? "verbose_json" : "json");

  try {
    const response = await (options.fetchFn ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
    if (!response.ok) return { ok: false, error: "api" };
    const payload = (await response.json()) as { text?: string; duration?: unknown };
    if (typeof payload.text !== "string") {
      return { ok: false, error: "invalid_response" };
    }
    const duration = payload.duration;
    const measured =
      options.withDuration &&
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration > 0;
    return {
      ok: true,
      text: payload.text.trim(),
      ...(measured ? { durationSeconds: duration } : {}),
    };
  } catch (error) {
    const name = (error as { name?: string }).name;
    return {
      ok: false,
      error:
        name === "AbortError" || name === "TimeoutError" ? "timeout" : "api",
    };
  }
}
