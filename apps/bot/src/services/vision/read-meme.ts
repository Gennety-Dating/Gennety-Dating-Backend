import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { MODELS } from "../../models.js";
import { openaiFetch } from "../openai-fetch.js";

/**
 * Read an image a user sent as their answer to the humour Profiler question
 * ("what actually makes you laugh — feel free to just send your favourite
 * meme") and turn it into ONE sentence of description, in their own language,
 * which is then stored as the ordinary `answerText` (PRODUCT_SPEC §Phase 1b).
 *
 * **Why a description and not the image.** Everything downstream of the
 * Profiler — the icebreaker generator, the wingman hint — is a text prompt over
 * `question → answer` lines (`formatProfilerAnswersBlock`). A sentence drops
 * straight into that pipeline; an image would mean teaching every consumer to
 * carry media. The bytes are still never persisted: we store what the picture
 * was about, plus (since §3.12 Meme Unlock) Telegram's own `file_id` for it, so
 * a meme nobody vetted never becomes an asset we are holding on someone's
 * behalf. Which makes THIS pass load-bearing for safety: a refusal here means
 * no description, the answer falls back to the caption, and a caption-only
 * answer carries no pointer — so an image this pass rejected can never be
 * re-sent to anyone.
 *
 * **What the sentence is for.** Not "a cat in a suit" — the description feeds
 * an icebreaker, so what matters is the register the joke reveals (dry, absurd,
 * self-deprecating, extremely online) and any subject a conversation could
 * actually hook onto. That is the whole reason the humour question is worth
 * asking with a picture at all: "good jokes" is not a signal, the kind of thing
 * a person finds funny is.
 *
 * Deliberately its own isolated pass, like `tag-appearance.ts`: a regression
 * here must not be able to perturb the Elo seed or the face checks that share
 * the vision tier. Uses the cheap `visionFast` model — this is a one-shot
 * description, not a matching-critical judgement. Never throws.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MEME_MODEL = MODELS.visionFast;
const DEFAULT_TIMEOUT_MS = 25_000;

/** Hard cap on the stored sentence — this is icebreaker fuel, not an essay. */
export const MEME_DESCRIPTION_MAX_LEN = 400;

export type ReadMemeResult =
  | { ok: true; description: string; model: string }
  | { ok: false; error: "disabled" | "api" | "timeout" | "unreadable" | "unsafe" };

export interface ReadMemeInput {
  buffer: Buffer;
  mime: string;
}

/**
 * Where the picture came from, when it was not simply attached to the message.
 *
 * Today the one case is a TikTok / Reels link: what we hold is the post's cover
 * frame plus the author's own caption, which is a materially different thing to
 * describe than a meme someone attached — the frame is one moment of a moving
 * joke, and the caption is usually the setup for it. Telling the model that is
 * the difference between "a woman standing in a kitchen" and a sentence
 * somebody could actually open a conversation with.
 */
export interface ReadMemeOrigin {
  kind: "short_video";
  platform: "tiktok" | "instagram";
  /** The author's caption on the post, not the sender's. */
  postCaption?: string | undefined;
  authorName?: string | undefined;
}

export interface ReadMemeOptions {
  /** The sender's language — the description is stored in it, exactly as a
   *  typed answer would be. */
  language: Language;
  /** Caption the image arrived with, if any. Real signal: it is often the
   *  user's own commentary on why the thing is funny. */
  caption?: string | undefined;
  /** Set when the image is a stand-in for something else (a linked video's
   *  cover frame) rather than the thing the user sent. */
  origin?: ReadMemeOrigin | undefined;
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

function buildInstruction(
  language: Language,
  caption: string | undefined,
  origin: ReadMemeOrigin | undefined,
): string {
  const platformName = origin?.platform === "instagram" ? "Instagram Reels" : "TikTok";
  return [
    ...(origin
      ? [
          "A person was asked what actually makes them laugh, and answered by",
          `linking a short ${platformName} video. You are looking at that`,
          "video's COVER FRAME, not the video — so describe what the video is",
          "about, using the frame and the caption together, and do not describe",
          "the frame as if it were a still photograph.",
          ...(origin.postCaption
            ? [
                "",
                "The author's caption on the post, which is usually the setup for",
                `the joke: "${origin.postCaption.slice(0, 400)}"`,
              ]
            : [
                "",
                "The post has no caption, so the frame is all you have. If it does",
                "not show enough to say what the video is about, say so plainly in",
                "one short sentence rather than inventing a premise.",
              ]),
          "",
        ]
      : [
          "A person was asked what actually makes them laugh, and answered by sending",
          "this image — usually a meme, a screenshot, or a funny photo.",
          "",
        ]),
    `Write ONE short sentence in ${LANGUAGE_NAMES[language]} describing what the`,
    "image is and what kind of humour it shows. Someone who has never seen the",
    "image should be able to bring it up in conversation from your sentence",
    "alone, so name the actual subject (the joke, the reference, the situation)",
    "and the register — dry, absurd, wholesome, self-deprecating, meme-literate,",
    "dark, silly. If it is a well-known meme format or a recognisable character,",
    "say which. Do not describe layout, resolution or watermarks, do not explain",
    "why it is funny at length, and never address the person.",
    "",
    ...(caption
      ? [
          "They sent it with these words of their own — treat them as their",
          `commentary and fold them in: "${caption.slice(0, 300)}"`,
          "",
        ]
      : []),
    "Set \"safe\" to false, and leave the description empty, if the image is",
    "sexually explicit, gore, or hateful. An edgy or crude joke is still safe —",
    "this is about content we cannot repeat back, not about taste.",
    "",
    'Return STRICT JSON exactly like: {"safe": true, "description": "..."}',
  ].join("\n");
}

/**
 * Describe one meme/screenshot image. `unreadable` means the model gave us
 * nothing usable (an empty description, an unparseable body); `unsafe` means it
 * refused the content on purpose. Callers distinguish the two because only the
 * first is worth asking the user to retry in words.
 */
export async function readMemeImage(
  image: ReadMemeInput,
  options: ReadMemeOptions,
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
        model: MEME_MODEL,
        max_completion_tokens: 200,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You describe images in one sentence, in the language you are asked for. You output JSON only.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildInstruction(options.language, caption, options.origin),
              },
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
    return parseMemeResponse(json.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "api" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse and validate the model's JSON body. Exported so the contract can be
 * unit-tested without the network — the refusal path in particular, which is
 * the one branch a live call almost never exercises.
 */
export function parseMemeResponse(raw: string): ReadMemeResult {
  let parsed: { safe?: unknown; description?: unknown };
  try {
    parsed = JSON.parse(raw.trim()) as { safe?: unknown; description?: unknown };
  } catch {
    return { ok: false, error: "api" };
  }
  // `safe` is only a refusal when it is explicitly false. A model that omits
  // the field has not flagged anything, and defaulting to "unsafe" there would
  // silently drop ordinary answers on a schema wobble.
  if (parsed.safe === false) return { ok: false, error: "unsafe" };
  const description =
    typeof parsed.description === "string"
      ? parsed.description.trim().slice(0, MEME_DESCRIPTION_MAX_LEN)
      : "";
  if (!description) return { ok: false, error: "unreadable" };
  return { ok: true, description, model: MEME_MODEL };
}
