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
 * Containers OpenAI accepts on the transcription endpoint, as file extensions.
 * @see https://platform.openai.com/docs/guides/speech-to-text
 */
const SUPPORTED_EXTENSIONS = new Set([
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "oga",
  "ogg",
  "wav",
  "webm",
]);

/** MIME types whose subtype is not itself the extension OpenAI expects. */
const EXTENSION_ALIASES: Record<string, string> = {
  "audio/opus": "ogg",
  "audio/vorbis": "ogg",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/x-flac": "flac",
};

/**
 * Filename to upload the buffer under.
 *
 * OpenAI reads the container from the uploaded FILE NAME, so the name has to
 * agree with the bytes: an AAC recording sent as `voice.ogg` is rejected as a
 * malformed OGG, not decoded as AAC. The name used to be hardcoded to
 * `voice.ogg`, which was invisible for as long as the only caller was Telegram
 * — voice notes really are Opus in OGG — and would have failed every upload
 * from the iOS chat, which records m4a.
 *
 * An unrecognised type returns null rather than guessing an extension. A wrong
 * guess costs a Whisper round-trip and comes back as the same failure; callers
 * already treat a failure as "ask them to type it instead".
 */
function transcriptionFilename(mime: string): string | null {
  const normalized = mime.split(";")[0]!.trim().toLowerCase();
  const aliased = EXTENSION_ALIASES[normalized];
  if (aliased) return `voice.${aliased}`;

  const subtype = normalized.split("/")[1] ?? "";
  if (SUPPORTED_EXTENSIONS.has(subtype)) return `voice.${subtype}`;
  return null;
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

  const filename = transcriptionFilename(mime);
  if (!filename) {
    console.warn("Voice transcription skipped: unsupported audio type", mime);
    return "";
  }

  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mime });
  form.append("file", blob, filename);
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
