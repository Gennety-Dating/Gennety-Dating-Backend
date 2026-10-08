import {
  WISHLIST_CATEGORIES,
  WISHLIST_PASTE_MAX_ENTRIES,
  isWishlistCategory,
  type Language,
  type WishlistCategory,
} from "@gennety/shared";
import { env } from "../config.js";
import { MODELS, normalizeChatCompletion } from "../models.js";
import { callOpenAIJson } from "./openai.js";
import { openaiFetch } from "./openai-fetch.js";
import {
  canonicalHttpsUrl,
  parseWishlistPaste,
  type WishlistPasteEntry,
} from "./wishlist-lookup.js";

/**
 * Date Wishlist by voice and by screenshots (decision journal 2026-10-08,
 * third: «есть ли голосовой… можно ли прикрепить фотографии? люди хранят скрины
 * желанных товаров»).
 *
 * Both turn what the person SAID or SAVED into the same look-up entries a
 * pasted list becomes (`parseWishlistPaste`), so everything after — the
 * per-card web search, the photo cards to confirm, «оставить своими словами» —
 * is the one path the typed list already has:
 *
 *  - **speech**: the Whisper transcript is free talk («ну я люблю пионы, и ещё
 *    хочу духи Шанель Шанс…»), which a comma split would cut into fillers. One
 *    cheap structured call lifts the concrete ideas out of it; when that call
 *    is down, the comma split is still better than nothing;
 *  - **screenshots**: up to `WISHLIST_SCREENSHOTS_MAX` images go to ONE vision
 *    call that names each wanted thing as a search query (brand + product +
 *    variant as printed) or as the product link when the address is readable.
 *
 * Nothing here is stored: not the audio, not the transcript, not the images.
 * What is kept is what the person confirms afterwards, exactly as with a
 * typed search.
 */

/** A look-up query is a description of one item, not an essay. */
const QUERY_MAX_LEN = 200;
const SPEECH_MAX_TOKENS = 700;
const SCREENSHOTS_MAX_TOKENS = 1_200;
const SCREENSHOTS_TIMEOUT_MS = 30_000;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  pl: "Polish",
};

export interface WishlistExtraction {
  mode: "links" | "text" | "mixed";
  entries: WishlistPasteEntry[];
}

export interface WishlistScreenshot {
  buffer: Buffer;
  /** Sniffed, not declared: jpeg / png / webp / gif. */
  mime: string;
}

export type WishlistScreenshotsResult =
  | (WishlistExtraction & { ok: true; unreadable: number })
  | { ok: false; error: "disabled" | "api" | "timeout" };

export interface ExtractDeps {
  fetchFn?: typeof fetch;
}

interface RawIdea {
  query?: unknown;
  category?: unknown;
  url?: unknown;
}

/* ── shared normalisation ───────────────────────────────────────────────── */

function tidyQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const one = raw.replace(/\s+/gu, " ").trim().replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/gu, "");
  return one.length > QUERY_MAX_LEN ? one.slice(0, QUERY_MAX_LEN).trimEnd() : one;
}

/**
 * Model ideas → entries: a readable https link becomes a `url` entry (the page
 * is then read for the exact product), everything else a `query`. Empty and
 * letterless pieces and case-insensitive repeats are dropped; at most
 * `WISHLIST_PASTE_MAX_ENTRIES`, ids `e1…eN` — the same contract as a paste.
 */
export function ideasToEntries(ideas: readonly RawIdea[]): WishlistExtraction {
  const seen = new Set<string>();
  const found: Array<Omit<WishlistPasteEntry, "id">> = [];
  for (const idea of ideas) {
    const category: WishlistCategory | undefined = isWishlistCategory(idea.category)
      ? idea.category
      : undefined;
    const link = typeof idea.url === "string" ? canonicalHttpsUrl(idea.url.trim()) : null;
    if (link) {
      const key = `u:${link}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind: "url", value: link, ...(category ? { category } : {}) });
      continue;
    }
    const query = tidyQuery(idea.query);
    if (!/[\p{L}\p{N}]/u.test(query)) continue;
    const key = `q:${query.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ kind: "query", value: query, ...(category ? { category } : {}) });
  }
  const entries = found
    .slice(0, WISHLIST_PASTE_MAX_ENTRIES)
    .map((entry, index) => ({ id: `e${index + 1}`, ...entry }));
  const hasUrl = entries.some((entry) => entry.kind === "url");
  const hasQuery = entries.some((entry) => entry.kind === "query");
  return { mode: hasUrl && hasQuery ? "mixed" : hasUrl ? "links" : "text", entries };
}

const CATEGORY_LIST = WISHLIST_CATEGORIES.join(", ");

/* ── speech ─────────────────────────────────────────────────────────────── */

const SPEECH_SCHEMA = {
  name: "wishlist_ideas",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["query", "category"],
          properties: {
            query: { type: "string" },
            category: { type: "string", enum: [...WISHLIST_CATEGORIES] },
          },
        },
      },
    },
  },
} as const;

function speechPrompt(language: Language): string {
  return [
    "A person is dictating their date wishlist: things they would love to be",
    "given or to do on a date — flowers, perfume, cosmetics, clothes, jewellery,",
    "a gift, a drink, a place, an experience. You receive the transcript of",
    "their voice note. List the concrete ideas in it, in the order they said",
    `them, at most ${WISHLIST_PASTE_MAX_ENTRIES}.`,
    "",
    'For each idea, "query" is what to type into a web search to find exactly',
    "that thing: keep brand and product names as they would be written in a",
    "shop (a spoken «Шанель Шанс» is «Chanel Chance»), add the variant, shade,",
    "colour or size they mentioned; a thing without a brand («пионы», «спа на",
    `двоих») is a short phrase in ${LANGUAGE_NAMES[language]}. "category" is one of:`,
    `${CATEGORY_LIST}.`,
    "",
    "Leave out filler, explanations and anything they say they do NOT want",
    "(«только не розы» is not an idea). One idea per thing: «духи и пионы» is two.",
    "If they named nothing concrete, return no items.",
    "",
    'Return JSON only: {"items":[{"query":"...","category":"..."}]}',
  ].join("\n");
}

/**
 * Ideas from a transcribed voice note. Never throws; when the model is
 * unavailable the transcript is split like a pasted line, so a dictated
 * «пионы, духи Chloé, спа» still reaches the search.
 */
export async function extractWishlistFromSpeech(
  transcript: string,
  language: Language,
  deps: ExtractDeps = {},
): Promise<WishlistExtraction> {
  const text = transcript.trim();
  if (!text) return { mode: "text", entries: [] };
  const answer = await callOpenAIJson<{ items?: unknown }>(speechPrompt(language), text.slice(0, 4_000), {
    model: MODELS.fast,
    maxTokens: SPEECH_MAX_TOKENS,
    temperature: 0.1,
    jsonSchema: SPEECH_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });
  if (!answer || !Array.isArray(answer.items)) {
    return parseWishlistPaste(text);
  }
  return ideasToEntries(answer.items as RawIdea[]);
}

/* ── screenshots ────────────────────────────────────────────────────────── */

const SCREENSHOTS_SCHEMA = {
  name: "wishlist_screenshots",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items", "unreadable"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["query", "category", "url"],
          properties: {
            query: { type: "string" },
            category: { type: "string", enum: [...WISHLIST_CATEGORIES] },
            url: { type: ["string", "null"] },
          },
        },
      },
      unreadable: { type: "integer" },
    },
  },
} as const;

function screenshotsPrompt(language: Language, count: number): string {
  return [
    `You get ${count === 1 ? "an image" : `${count} images`} a person saved because they would love to`,
    "get or do the thing in it — a gift, perfume, flowers, clothes, jewellery,",
    "cosmetics, a place, an experience. Usually a screenshot of a shop page or",
    "of social media; sometimes a photo of a shop window, or a notes app / chat",
    "with a written list of wishes. They are building their date wishlist.",
    "",
    `List the concrete things they want, at most ${WISHLIST_PASTE_MAX_ENTRIES} across all images,`,
    "without repeats: the same product on two screenshots is one item.",
    'For each item, "query" is what to type into a web search to find exactly',
    "that item: brand + product name + the variant, shade, colour or volume when",
    "visible, written as on the image (Latin names stay Latin). A thing with no",
    `brand (peonies, a spa day) is a short phrase in ${LANGUAGE_NAMES[language]}.`,
    `"category" is one of: ${CATEGORY_LIST}.`,
    '"url" is the product page address ONLY when it is fully readable on the',
    "image (an address bar, a shared link) and starts with https; otherwise null.",
    "",
    "Ignore what is not their wish: interface chrome, prices, delivery terms,",
    "«you may also like» rows, ads for other things, and anything personal —",
    "names, phone numbers, messages of other people. Never describe people.",
    'Count in "unreadable" every image you skipped: one that shows nothing',
    "anyone could want, or that is sexually explicit, gore or hateful.",
    "",
    'Return JSON only: {"items":[{"query":"...","category":"...","url":null}],"unreadable":0}',
  ].join("\n");
}

/**
 * Ideas off up to `WISHLIST_SCREENSHOTS_MAX` screenshots, in one vision call.
 * Never throws. The bytes go to the model and nowhere else.
 */
export async function extractWishlistFromScreenshots(
  images: readonly WishlistScreenshot[],
  language: Language,
  deps: ExtractDeps = {},
): Promise<WishlistScreenshotsResult> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "disabled" };
  if (images.length === 0) return { ok: true, mode: "text", entries: [], unreadable: 0 };

  const fetchFn = deps.fetchFn ?? openaiFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCREENSHOTS_TIMEOUT_MS);
  try {
    const res = await fetchFn(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(normalizeChatCompletion({
        model: MODELS.visionFast,
        max_completion_tokens: SCREENSHOTS_MAX_TOKENS,
        temperature: 0.1,
        response_format: { type: "json_schema", json_schema: SCREENSHOTS_SCHEMA },
        messages: [
          {
            role: "system",
            content: "You read screenshots of things people want and list them for a web search. You output JSON only.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: screenshotsPrompt(language, images.length) },
              ...images.map((image) => ({
                type: "image_url",
                image_url: {
                  url: `data:${image.mime};base64,${image.buffer.toString("base64")}`,
                  // Product names on a shop page are small print; «high» is
                  // what makes them readable.
                  detail: "high",
                },
              })),
            ],
          },
        ],
      })),
    });
    if (!res.ok) return { ok: false, error: "api" };
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseScreenshotsAnswer(json.choices?.[0]?.message?.content ?? "", images.length);
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return { ok: false, error: "timeout" };
    return { ok: false, error: "api" };
  } finally {
    clearTimeout(timer);
  }
}

/** The vision answer → entries. Exported for the contract tests. */
export function parseScreenshotsAnswer(raw: string, imageCount: number): WishlistScreenshotsResult {
  let parsed: { items?: unknown; unreadable?: unknown };
  try {
    parsed = JSON.parse(raw.trim()) as { items?: unknown; unreadable?: unknown };
  } catch {
    return { ok: false, error: "api" };
  }
  const items = Array.isArray(parsed.items) ? (parsed.items as RawIdea[]) : [];
  const unreadable =
    typeof parsed.unreadable === "number" && Number.isFinite(parsed.unreadable)
      ? Math.min(imageCount, Math.max(0, Math.round(parsed.unreadable)))
      : 0;
  return { ok: true, ...ideasToEntries(items), unreadable };
}
