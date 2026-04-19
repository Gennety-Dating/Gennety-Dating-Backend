import { env } from "../config.js";

const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = "whisper-1";
const WHISPER_TIMEOUT_MS = 45_000;

export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

interface WhisperResponse {
  text?: string;
}

export interface TranscribeOptions {
  /** MIME type of the audio buffer. Telegram voice notes are Opus in OGG. */
  mime?: string;
  /** Optional ISO-639-1 language hint ("en", "ru", "uk"). */
  language?: string;
  /** Injectable fetch for testing. */
  fetchFn?: typeof fetch;
}

/**
 * Transcribe a voice-note buffer via OpenAI Whisper.
 *
 * Returns the transcript, or an empty string if the API key is missing,
 * the request fails, or no text is returned. Callers treat "" as "failed —
 * ask the user to type instead" and must not feed it to the LLM router.
 *
 * Uses raw fetch + built-in FormData/Blob (Node 20+) to avoid pulling in the
 * OpenAI SDK (see AGENTS.md: no new deps without approval).
 */
export async function transcribeVoice(
  buffer: Buffer,
  options: TranscribeOptions = {},
): Promise<string> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return "";

  if (buffer.byteLength === 0 || buffer.byteLength > WHISPER_MAX_BYTES) {
    return "";
  }

  const fetchFn = options.fetchFn ?? fetch;
  const mime = options.mime ?? "audio/ogg";

  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mime });
  form.append("file", blob, "voice.ogg");
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "json");
  if (options.language) form.append("language", options.language);

  try {
    const res = await fetchFn(WHISPER_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`Whisper call failed: ${res.status} ${body}`);
      return "";
    }

    const json = (await res.json()) as WhisperResponse;
    return json.text?.trim() ?? "";
  } catch (err) {
    console.warn("Whisper call error:", err);
    return "";
  }
}
