import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { MODELS } from "../../models.js";
import { openaiFetch } from "../openai-fetch.js";
import { parseMemeResponse, type ReadMemeInput, type ReadMemeResult } from "./read-meme.js";

/**
 * Read a VIDEO a person attached to their Profiler answer in the app
 * (`POST /v1/me/profiler/answer/media`, parts `videoFrames` + `videoAudio`)
 * and turn it into one short description, in their own language, stored
 * inside the ordinary `answerText` (PRODUCT_SPEC §Phase 1b) — the third
 * sibling of `read-meme.ts` and `read-answer-photo.ts`.
 *
 * **Why frames and not the file.** The server has no ffmpeg and the vision
 * endpoint takes no video, so the app does the cutting: it picks a few frames
 * evenly across the clip (or an animated GIF) and sends them in order, with the
 * clip's soundtrack as a separate part. This pass looks at ALL the frames in
 * one call, told they are moments of one clip — so it describes what happens,
 * not N stills — and gets what was SAID in the clip (the soundtrack's
 * transcript), which is often the whole joke of a meme video.
 *
 * Two readings, like the photo pair: on the questions that ask for a picture
 * (`acceptsImage` — humour) the clip is a meme, and what matters is the kind of
 * humour; on every other question it is evidence for an answer, read against
 * the question text.
 *
 * Same `{safe, description}` JSON, same `parseMemeResponse` and 400-character
 * cap, so the service treats it like a photo: a refusal (`unsafe`) means the
 * clip contributes nothing. Cheap `visionFast` tier. Never throws.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const VIDEO_MODEL = MODELS.visionFast;
const DEFAULT_TIMEOUT_MS = 35_000;

export interface ReadAnswerVideoOptions {
  /** The person's language — the description is stored in it. */
  language: Language;
  /** The question as the person saw it, in their language. */
  questionText: string;
  /** The humour question: read the clip as a meme, not as evidence. */
  meme: boolean;
  /** Their own words sent with the clip, if any. */
  caption?: string | undefined;
  /** What is said in the clip — the soundtrack's transcript, NOT their words. */
  soundTranscript?: string | undefined;
  /** Clip length, as the app measured it. */
  durationSeconds?: number | undefined;
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

export function buildVideoInstruction(frameCount: number, options: ReadAnswerVideoOptions): string {
  const language = LANGUAGE_NAMES[options.language];
  const caption = options.caption?.trim();
  const sound = options.soundTranscript?.trim();
  const length = options.durationSeconds && options.durationSeconds > 0
    ? ` about ${Math.round(options.durationSeconds)} seconds long`
    : "";
  return [
    ...(options.meme
      ? [
          "A person was asked what actually makes them laugh, and answered by",
          `sending a short video${length} — usually a meme clip or a funny moment.`,
        ]
      : [
          "A person on a dating app was asked this question about themselves:",
          `"${options.questionText.slice(0, 400)}"`,
          "",
          `They answered (fully or partly) by attaching a short video${length}.`,
        ]),
    "",
    `You are looking at ${frameCount} frame${frameCount === 1 ? "" : "s"} taken evenly from that ONE`,
    "video, in order. Describe the video — what happens in it — not the frames",
    "as separate photographs.",
    ...(sound
      ? [
          "",
          "What is said or sung in the video (its soundtrack, transcribed — not the",
          `person's own words): "${sound.slice(0, 500)}"`,
        ]
      : []),
    "",
    ...(options.meme
      ? [
          `Write ONE short sentence in ${language} describing what the video is`,
          "and what kind of humour it shows. Someone who has never seen it should",
          "be able to bring it up in conversation from your sentence alone, so",
          "name the actual subject (the joke, the reference, the situation) and the",
          "register — dry, absurd, wholesome, self-deprecating, meme-literate,",
          "dark, silly. If it is a well-known meme or a recognisable character,",
          "say which.",
        ]
      : [
          `Write ONE or TWO short sentences in ${language} saying what the video`,
          "shows, as their answer to the question: name the concrete things a",
          "conversation could hook onto (the place, the activity, the food, the",
          "music, the pet, the view) and what it says in answer to the question.",
          "Someone who never sees the video should understand the answer from your",
          "words alone.",
        ]),
    "Describe only what is visible or audible — do not invent names, places or",
    "feelings — and say nothing about anyone's looks or body. Do not describe",
    "resolution, watermarks or that these are frames, and never address the person.",
    "",
    ...(caption
      ? [
          "They sent it with these words of their own — read the video in their",
          `light, but do not repeat them: "${caption.slice(0, 300)}"`,
          "",
        ]
      : []),
    "Set \"safe\" to false, and leave the description empty, if the video is",
    "sexually explicit, gore, or hateful, or shows documents with personal data.",
    "",
    'Return STRICT JSON exactly like: {"safe": true, "description": "..."}',
  ].join("\n");
}

/**
 * Describe one answer video from its frames. `unreadable` = no frames or the
 * model gave nothing usable; `unsafe` = refused on purpose; `disabled` / `api`
 * / `timeout` = our side.
 */
export async function readAnswerVideo(
  frames: readonly ReadMemeInput[],
  options: ReadAnswerVideoOptions,
): Promise<ReadMemeResult> {
  const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? openaiFetch;

  if (!apiKey) return { ok: false, error: "disabled" };
  const usable = frames.filter((frame) => frame.buffer.length > 0);
  if (usable.length === 0) return { ok: false, error: "unreadable" };

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
        model: VIDEO_MODEL,
        max_completion_tokens: 260,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You describe short videos from their frames, briefly, in the language you are asked for. You output JSON only.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: buildVideoInstruction(usable.length, options) },
              ...usable.map((frame) => ({
                type: "image_url" as const,
                image_url: {
                  url: `data:${frame.mime || "image/jpeg"};base64,${frame.buffer.toString("base64")}`,
                },
              })),
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
    return parsed.ok ? { ...parsed, model: VIDEO_MODEL } : parsed;
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "api" };
  } finally {
    clearTimeout(timer);
  }
}
