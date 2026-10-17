import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { MODELS } from "../../models.js";
import { openaiFetch } from "../openai-fetch.js";
import { parseMemeResponse, type ReadMemeInput, type ReadMemeResult } from "./read-meme.js";

/**
 * Read a photo a person attached to their answer to an ORDINARY Profiler
 * question in the app (`POST /v1/me/profiler/answer/media`) and turn it into a
 * short description, in their own language, that is stored inside the
 * ordinary `answerText` (PRODUCT_SPEC §Phase 1b).
 *
 * The sibling of `read-meme.ts`, which stays the reader for the questions that
 * ask for a picture in so many words (`acceptsImage` — humour). Every other
 * question can carry a photo in the app too ("where would you take me?" → a
 * snapshot of a bar), and there the photo is not a joke to classify but
 * EVIDENCE for an answer: what matters is what it shows that bears on the
 * question, so the prompt carries the question text.
 *
 * Same contract as the meme reader, on purpose — the same `{safe, description}`
 * JSON, parsed by the same `parseMemeResponse`, the same 400-character cap — so
 * the route treats both readers alike and a refusal (`unsafe`) means the photo
 * contributes nothing and is never stored. Uses the cheap `visionFast` tier.
 * Never throws.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const PHOTO_MODEL = MODELS.visionFast;
const DEFAULT_TIMEOUT_MS = 25_000;

export interface ReadAnswerPhotoOptions {
  /** The person's language — the description is stored in it. */
  language: Language;
  /** The question as the person saw it, in their language. */
  questionText: string;
  /** Their own words sent with the photo, if any. */
  caption?: string | undefined;
  openaiApiKey?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  pl: "Polish",
};

function buildInstruction(language: Language, questionText: string, caption: string | undefined): string {
  return [
    "A person on a dating app was asked this question about themselves:",
    `"${questionText.slice(0, 400)}"`,
    "",
    "They answered (fully or partly) by attaching this photo.",
    "",
    `Write ONE or TWO short sentences in ${LANGUAGE_NAMES[language]} saying what`,
    "the photo shows, as their answer to the question: name the concrete things",
    "a conversation could hook onto (the place, the food, the activity, the",
    "object, the book, the view, the pet) and what it says in answer to the",
    "question. Someone who never sees the photo should understand the answer",
    "from your words alone. Describe only what is visible — do not invent names,",
    "places or feelings — and say nothing about anyone's looks or body. Do not",
    "describe layout, resolution or watermarks, and never address the person.",
    "",
    ...(caption
      ? [
          "They sent it with these words of their own — read the photo in their",
          `light, but do not repeat them: "${caption.slice(0, 300)}"`,
          "",
        ]
      : []),
    "Set \"safe\" to false, and leave the description empty, if the photo is",
    "sexually explicit, gore, or hateful, or shows documents with personal data.",
    "",
    'Return STRICT JSON exactly like: {"safe": true, "description": "..."}',
  ].join("\n");
}

/**
 * Describe one answer photo. `unreadable` = the model gave nothing usable;
 * `unsafe` = refused on purpose; `disabled` / `api` / `timeout` = our side.
 */
export async function readAnswerPhoto(
  image: ReadMemeInput,
  options: ReadAnswerPhotoOptions,
): Promise<ReadMemeResult> {
  const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? openaiFetch;

  if (!apiKey) return { ok: false, error: "disabled" };
  if (image.buffer.length === 0) return { ok: false, error: "unreadable" };

  const caption = options.caption?.trim() || undefined;
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
        model: PHOTO_MODEL,
        max_completion_tokens: 220,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You describe photos briefly, in the language you are asked for. You output JSON only.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: buildInstruction(options.language, options.questionText, caption) },
              {
                type: "image_url",
                image_url: {
                  url: `data:${image.mime || "image/jpeg"};base64,${image.buffer.toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return { ok: false, error: "api" };

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const parsed = parseMemeResponse(json.choices?.[0]?.message?.content ?? "");
    return parsed.ok ? { ...parsed, model: PHOTO_MODEL } : parsed;
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "api" };
  } finally {
    clearTimeout(timer);
  }
}
