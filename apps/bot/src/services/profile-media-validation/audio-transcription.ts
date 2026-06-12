import { env } from "../../config.js";
import type { ProviderError } from "./types.js";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = "whisper-1";

export type AudioTranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; error: ProviderError };

export interface AudioTranscriptionOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
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
  form.append("response_format", "json");

  try {
    const response = await (options.fetchFn ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
    if (!response.ok) return { ok: false, error: "api" };
    const payload = (await response.json()) as { text?: string };
    if (typeof payload.text !== "string") {
      return { ok: false, error: "invalid_response" };
    }
    return { ok: true, text: payload.text.trim() };
  } catch (error) {
    const name = (error as { name?: string }).name;
    return {
      ok: false,
      error:
        name === "AbortError" || name === "TimeoutError" ? "timeout" : "api",
    };
  }
}
