import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { MODELS } from "../../models.js";
import { openaiFetch } from "../openai-fetch.js";
import { readResponseBuffer } from "../../utils/bounded-response.js";

/**
 * Face-validation service for onboarding photo upload.
 *
 * Given a Telegram `file_id`, download the image and ask OpenAI's
 * vision-capable model (`MODELS.visionFast`) whether it can work as a
 * one-person profile photo. Used to reject memes, landscapes, group photos, or
 * unusably low-quality selfies during Phase 1 Step 7.
 *
 * @see PRODUCT_SPEC.md — Phase 1 Step 7 (Photo Upload)
 * @see https://core.telegram.org/bots/api#getfile
 * @see https://platform.openai.com/docs/guides/vision
 */

/**
 * Discriminated result of a validation call.
 *
 * - `{ ok: true, valid: boolean }` — the vision model ran successfully;
 *   `valid` tells us whether the image passed the single-face check.
 * - `{ ok: false, error }` — infrastructure failure. Callers should ask
 *   the user to retry the same photo rather than reject it outright.
 */
export type FaceValidationResult =
  | { ok: true; valid: boolean }
  | { ok: false; error: "timeout" | "api" };

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const VISION_MODEL = MODELS.visionFast;
const SYSTEM_PROMPT =
  "Decide if this can be accepted as a dating profile photo for one person. " +
  "Answer only 'true' or 'false'. Accept normal selfies, portraits, mirror shots, " +
  "full-body photos, hats, glasses, mild angles, and imperfect lighting as long as " +
  "one person's face is visible. Reject only if there is no human face, multiple " +
  "people are visible, the face is extremely obscured/tiny, or it is clearly not a " +
  "real profile photo.";
const DEFAULT_TIMEOUT_MS = 10_000;
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export interface ValidateFaceOptions {
  /** Override the Telegram bot token (defaults to `env.BOT_TOKEN`). */
  botToken?: string;
  /** Override the OpenAI API key (defaults to `env.OPENAI_API_KEY`). */
  openaiApiKey?: string;
  /** Max milliseconds to wait for the OpenAI round-trip. */
  timeoutMs?: number;
  /** Injectable fetch, used by tests. */
  fetchFn?: typeof fetch;
  /** Injectable `getFile`, used by tests to avoid touching `ctx.api`. */
  getFile?: (fileId: string) => Promise<{ file_path?: string }>;
}

/**
 * Validate that a Telegram photo can work as a one-person profile photo.
 *
 * Flow:
 *   1. Resolve `file_id` → public file URL via Telegram `getFile`.
 *   2. Download the Telegram-hosted bytes ourselves.
 *   3. POST a base64 data URL to OpenAI `chat.completions`.
 *   4. Parse the model's reply: strictly "true" or "false" (case-insensitive).
 *
 * Never throws — callers branch on the discriminated result. If the
 * OpenAI API key is not configured (e.g. local dev), the validator
 * fails *open* so onboarding remains usable without the feature.
 */
/**
 * Validate a raw image buffer (no Telegram involved). Used by the mobile
 * `/v1/me/verify-selfie` endpoint which hands us multipart bytes directly.
 *
 * Same one-person profile-photo prompt as `validateSingleFace`; buffer is
 * passed to OpenAI as a base64 data URL so we don't need to pre-upload anywhere.
 */
export async function validateSingleFaceFromBuffer(
  buffer: Buffer,
  mime: string,
  options: Omit<ValidateFaceOptions, "botToken" | "getFile"> = {},
): Promise<FaceValidationResult> {
  const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? openaiFetch;

  // No key configured → fail open for local dev.
  if (!apiKey) return { ok: true, valid: true };

  const dataUrl = `data:${mime || "image/jpeg"};base64,${buffer.toString("base64")}`;
  return validateSingleFaceImageUrl(dataUrl, apiKey, timeoutMs, fetchFn);
}

async function validateSingleFaceImageUrl(
  imageUrl: string,
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<FaceValidationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        max_completion_tokens: 16,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: imageUrl } }],
          },
        ],
      }),
    });

    if (!res.ok) return { ok: false, error: "api" };

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "";
    if (raw.startsWith("true")) return { ok: true, valid: true };
    if (raw.startsWith("false")) return { ok: true, valid: false };
    return { ok: false, error: "api" };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "api" };
  } finally {
    clearTimeout(timer);
  }
}

export async function validateSingleFace(
  ctx: BotContext,
  fileId: string,
  options: ValidateFaceOptions = {},
): Promise<FaceValidationResult> {
  const botToken = options.botToken ?? env.BOT_TOKEN;
  const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? openaiFetch;
  const getFile = options.getFile ?? ((id: string) => ctx.api.getFile(id));

  // No key configured → fail open so local dev still works.
  if (!apiKey) {
    return { ok: true, valid: true };
  }

  let fileUrl: string;
  try {
    const file = await getFile(fileId);
    if (!file.file_path) return { ok: false, error: "api" };
    fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  } catch {
    return { ok: false, error: "api" };
  }

  let buffer: Buffer;
  let mime = "image/jpeg";
  try {
    const fileRes = await fetchFn(fileUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!fileRes.ok) return { ok: false, error: "api" };
    mime = fileRes.headers.get("content-type") ?? mime;
    buffer = await readResponseBuffer(fileRes, TELEGRAM_PHOTO_MAX_BYTES);
  } catch (err) {
    const name = (err as { name?: string }).name;
    return {
      ok: false,
      error: name === "AbortError" || name === "TimeoutError" ? "timeout" : "api",
    };
  }

  const dataUrlResult = await validateSingleFaceFromBuffer(buffer, mime, {
    openaiApiKey: apiKey,
    timeoutMs,
    fetchFn,
  });
  if (dataUrlResult.ok) return dataUrlResult;

  // Some vision endpoints/models are stricter about data URLs than remote
  // image URLs. If the server-side byte path fails, fall back to the original
  // Telegram file URL with the same relaxed profile-photo prompt.
  return validateSingleFaceImageUrl(fileUrl, apiKey, timeoutMs, fetchFn);
}
