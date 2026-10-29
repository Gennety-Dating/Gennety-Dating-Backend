import {
  WISHLIST_CATEGORIES,
  isWishlistCategory,
  type Language,
  type WishlistCategory,
} from "@gennety/shared";
import { env } from "../../config.js";
import { MODELS, normalizeChatCompletion } from "../../models.js";
import { openaiFetch } from "../openai-fetch.js";
import { fetchShortVideoMetadata, resolveShortVideoRef } from "../short-video/metadata.js";
import {
  fetchAllowlistedImage,
  fetchAllowlistedPage,
} from "../short-video/safe-fetch.js";
import {
  classifyShareVideoUrl,
  isSharePosterHost,
  isShareVideoHost,
  type ShareVideoPlatform,
  type ShareVideoRef,
} from "./links.js";

/**
 * «Поделиться → Gennety» for a short video (decision journal 2026-10-24): what
 * the iOS share sheet shows for a Reel, a TikTok or a YouTube Short.
 *
 * DEPTH, decided with the founder: only what a logged-out browser is served —
 * the caption, the title, the author and the cover frame. No frames, no audio,
 * no download. One vision call turns that into a title, a one-line summary,
 * one interest for the profile, one item or place for the wishlist and up to
 * three questions — and is told plainly not to claim anything the cover and
 * caption do not show.
 *
 * Never throws. A platform that gives nothing is `closed` (the sheet says so);
 * a model that fails still leaves a `read` built from the caption, because a
 * caption-titled sheet with the question field is more useful than an error.
 */

export interface ShareVideoItem {
  title: string;
  kind: "item" | "place";
  category: WishlistCategory;
  /** A web-search query that finds this exact thing (`/wishlist/lookup`). */
  query: string;
  brand?: string | undefined;
}

export interface ShareVideo {
  status: "read" | "closed";
  platform: ShareVideoPlatform;
  url: string;
  author?: string | undefined;
  posterUrl?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  interest?: { label: string } | undefined;
  item?: ShareVideoItem | undefined;
  questions: string[];
}

/** What the answer to a question may lean on — kept server-side, not sent. */
export interface ShareVideoGrounding {
  caption?: string | undefined;
  coverDescription?: string | undefined;
}

export type ShareVideoReadOutcome =
  | { ok: true; video: ShareVideo; grounding: ShareVideoGrounding }
  | { ok: false; error: "not_video" };

export interface ShareVideoMetadata {
  caption?: string | undefined;
  author?: string | undefined;
  posterUrl?: string | undefined;
  /** The canonical ref after a share stub was resolved. */
  ref: ShareVideoRef;
}

export interface ShareVideoAnalysis {
  safe: boolean;
  title: string;
  summary: string;
  coverDescription: string;
  interest: string | null;
  item: ShareVideoItem | null;
  questions: string[];
}

export interface ShareVideoAnalysisInput {
  platform: ShareVideoPlatform;
  caption?: string | undefined;
  author?: string | undefined;
  poster?: Buffer | undefined;
  language: Language;
  cityKey: string | null;
}

export interface ShareVideoReadDeps {
  metadata?: (ref: ShareVideoRef) => Promise<ShareVideoMetadata | null>;
  poster?: (url: string) => Promise<Buffer | null>;
  analyze?: (input: ShareVideoAnalysisInput) => Promise<ShareVideoAnalysis | null>;
  now?: () => number;
}

/* ── limits ─────────────────────────────────────────────────────────────── */

export const SHARE_VIDEO_TITLE_MAX = 60;
export const SHARE_VIDEO_SUMMARY_MAX = 140;
export const SHARE_VIDEO_INTEREST_MAX = 50;
export const SHARE_VIDEO_ITEM_TITLE_MAX = 60;
export const SHARE_VIDEO_QUERY_MAX = 120;
export const SHARE_VIDEO_BRAND_MAX = 40;
export const SHARE_VIDEO_QUESTION_MAX = 28;
export const SHARE_VIDEO_QUESTIONS = 3;

const ANALYSIS_TIMEOUT_MS = 25_000;
const ANALYSIS_MAX_TOKENS = 700;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** Readable videos are stable; a closed one may open up (Meta's login wall). */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CLOSED_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  pl: "Polish",
};

/* ── cache ──────────────────────────────────────────────────────────────── */

interface CacheEntry {
  at: number;
  outcome: Extract<ShareVideoReadOutcome, { ok: true }>;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ShareVideoReadOutcome>>();

/** Tests only. */
export function clearShareVideoCache(): void {
  cache.clear();
  inFlight.clear();
}

function cacheGet(key: string, now: number): CacheEntry["outcome"] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  const ttl = hit.outcome.video.status === "closed" ? CLOSED_TTL_MS : CACHE_TTL_MS;
  if (now - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.outcome;
}

function cachePut(key: string, outcome: CacheEntry["outcome"], now: number): void {
  cache.delete(key);
  cache.set(key, { at: now, outcome });
  // Map keeps insertion order: the first key is the oldest write.
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/* ── text helpers ───────────────────────────────────────────────────────── */

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/** A caption's first sentence, as a title when the model gave none. */
function titleFromCaption(caption: string | undefined): string | undefined {
  if (!caption) return undefined;
  const withoutTags = caption.replace(/(^|\s)[#@][\p{L}\p{N}_.]+/gu, " ");
  const first = withoutTags.split(/(?<=[.!?…])\s/u)[0];
  return clip(first, SHARE_VIDEO_TITLE_MAX);
}

function httpsPoster(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || !isSharePosterHost(url.hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/* ── default deps ───────────────────────────────────────────────────────── */

interface YouTubeOembed {
  title?: unknown;
  author_name?: unknown;
  thumbnail_url?: unknown;
}

async function defaultMetadata(ref: ShareVideoRef): Promise<ShareVideoMetadata | null> {
  const timeoutMs = env.SHORT_VIDEO_FETCH_TIMEOUT_MS;
  if (ref.platform === "youtube") {
    // YouTube's oEmbed is public and stable; the watch page is megabytes of
    // script and adds nothing the title does not already say.
    const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(ref.url)}`;
    const page = await fetchAllowlistedPage(endpoint, isShareVideoHost, { timeoutMs });
    if (!page.ok) return null;
    let payload: YouTubeOembed;
    try {
      payload = JSON.parse(page.body) as YouTubeOembed;
    } catch {
      return null;
    }
    const caption = clip(payload.title, 600);
    const posterUrl = typeof payload.thumbnail_url === "string" ? payload.thumbnail_url : undefined;
    if (!caption && !posterUrl) return null;
    return { ref, caption, author: clip(payload.author_name, 100), posterUrl };
  }

  const short = { platform: ref.platform, externalId: ref.externalId, url: ref.url };
  // Instagram metadata already follows redirects and parses that final page.
  // Resolving a share stub first fetched the same reel HTML twice in series.
  const resolved = short.platform === "instagram"
    ? { ok: true as const, ref: short }
    : await resolveShortVideoRef(short, { timeoutMs });
  if (!resolved.ok) return null;
  const read = await fetchShortVideoMetadata(resolved.ref, { timeoutMs });
  if (!read.ok || !read.ref.externalId) return null;
  return {
    ref: { platform: read.ref.platform, externalId: read.ref.externalId, url: read.ref.url },
    caption: read.metadata.caption,
    author: read.metadata.authorName,
    posterUrl: read.metadata.posterUrl,
  };
}

async function defaultPoster(url: string): Promise<Buffer | null> {
  const image = await fetchAllowlistedImage(url, isSharePosterHost, {
    timeoutMs: env.SHORT_VIDEO_FETCH_TIMEOUT_MS,
  });
  return image.ok && image.buffer.length > 0 ? image.buffer : null;
}

/* ── the model call ─────────────────────────────────────────────────────── */

const ANALYSIS_SCHEMA = {
  name: "share_video",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["safe", "title", "summary", "coverDescription", "interest", "item", "questions"],
    properties: {
      safe: { type: "boolean" },
      title: { type: "string" },
      summary: { type: "string" },
      coverDescription: { type: "string" },
      interest: { type: ["string", "null"] },
      item: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["title", "kind", "category", "query", "brand"],
            properties: {
              title: { type: "string" },
              kind: { type: "string", enum: ["item", "place"] },
              category: { type: "string", enum: [...WISHLIST_CATEGORIES] },
              query: { type: "string" },
              brand: { type: ["string", "null"] },
            },
          },
          { type: "null" },
        ],
      },
      questions: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export function analysisPrompt(input: Omit<ShareVideoAnalysisInput, "poster"> & { hasCover: boolean }): string {
  const language = LANGUAGE_NAMES[input.language];
  const platform = { tiktok: "TikTok", instagram: "Instagram Reels", youtube: "YouTube" }[input.platform];
  return [
    `Someone shared a ${platform} video into a dating app to save what they liked about it.`,
    input.hasCover
      ? "You see its COVER FRAME and its caption — not the video itself."
      : "You only have its caption — there is no cover image.",
    ...(input.caption ? ["", `Caption: "${input.caption.slice(0, 600)}"`] : []),
    ...(input.author ? [`Author: ${input.author.slice(0, 100)}`] : []),
    ...(input.cityKey ? [`The person lives in: ${input.cityKey}.`] : []),
    "",
    `Write every text field in ${language}. Only claim what the cover and the caption`,
    "actually show; never invent names, prices, addresses or brands.",
    "",
    `- "title": what the video is about, ≤${SHARE_VIDEO_TITLE_MAX} chars, not the raw caption.`,
    `- "summary": one sentence, ≤${SHARE_VIDEO_SUMMARY_MAX} chars.`,
    '- "coverDescription": one factual sentence on what the cover frame shows (empty if no cover).',
    `- "interest": ONE short hobby-like topic for a dating profile, ≤${SHARE_VIDEO_INTEREST_MAX} chars,`,
    '  a noun phrase like "Specialty coffee" / "Спешелти-кофе"; null if the video has no clear topic.',
    '- "item": the ONE concrete thing worth a wishlist — a product (kind "item") or a venue for a',
    '  date (kind "place") — only when the cover or caption names or clearly shows it; else null.',
    `  "title" ≤${SHARE_VIDEO_ITEM_TITLE_MAX} chars; "category" from the list; "query" ≤${SHARE_VIDEO_QUERY_MAX} chars,`,
    "  a web-search query that finds exactly this (brand + model, or venue + city);",
    `  "brand" ≤${SHARE_VIDEO_BRAND_MAX} chars or null.`,
    `- "questions": up to ${SHARE_VIDEO_QUESTIONS} short questions (≤${SHARE_VIDEO_QUESTION_MAX} chars) this person`,
    '  would ask about the video ("Where is this?", "How much?").',
    '- "safe": false (and everything else empty/null) if the content is sexually explicit, gore or',
    "  hateful. Edgy or crude is still safe.",
  ].join("\n");
}

async function defaultAnalyze(input: ShareVideoAnalysisInput): Promise<ShareVideoAnalysis | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const prompt = analysisPrompt({ ...input, hasCover: Boolean(input.poster) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
  try {
    const res = await openaiFetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(
        normalizeChatCompletion({
          model: input.poster ? MODELS.visionFast : MODELS.fast,
          max_completion_tokens: ANALYSIS_MAX_TOKENS,
          temperature: 0.2,
          response_format: { type: "json_schema", json_schema: ANALYSIS_SCHEMA },
          messages: [
            {
              role: "system",
              content: "You describe short videos people share, from their cover and caption. You output JSON only.",
            },
            {
              role: "user",
              content: input.poster
                ? [
                    { type: "text", text: prompt },
                    {
                      type: "image_url",
                      image_url: { url: `data:image/jpeg;base64,${input.poster.toString("base64")}` },
                    },
                  ]
                : prompt,
            },
          ],
        }),
      ),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseShareVideoAnalysis(json.choices?.[0]?.message?.content ?? "");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The model's JSON → a clipped, validated analysis. Exported for tests. */
export function parseShareVideoAnalysis(raw: string): ShareVideoAnalysis | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.safe === false) {
    return { safe: false, title: "", summary: "", coverDescription: "", interest: null, item: null, questions: [] };
  }
  const rawItem = parsed.item as Record<string, unknown> | null | undefined;
  let item: ShareVideoItem | null = null;
  if (rawItem && typeof rawItem === "object") {
    const title = clip(rawItem.title, SHARE_VIDEO_ITEM_TITLE_MAX);
    const query = clip(rawItem.query, SHARE_VIDEO_QUERY_MAX);
    if (title && query && isWishlistCategory(rawItem.category)) {
      item = {
        title,
        kind: rawItem.kind === "place" ? "place" : "item",
        category: rawItem.category,
        query,
        brand: clip(rawItem.brand, SHARE_VIDEO_BRAND_MAX),
      };
    }
  }
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions
        .map((q) => clip(q, SHARE_VIDEO_QUESTION_MAX))
        .filter((q): q is string => Boolean(q))
        .slice(0, SHARE_VIDEO_QUESTIONS)
    : [];
  return {
    safe: true,
    title: clip(parsed.title, SHARE_VIDEO_TITLE_MAX) ?? "",
    summary: clip(parsed.summary, SHARE_VIDEO_SUMMARY_MAX) ?? "",
    coverDescription: clip(parsed.coverDescription, 300) ?? "",
    interest: clip(parsed.interest, SHARE_VIDEO_INTEREST_MAX) ?? null,
    item,
    questions,
  };
}

/* ── the read ───────────────────────────────────────────────────────────── */

export async function readSharedVideo(
  rawUrl: string,
  viewer: { language: Language; cityKey: string | null },
  deps: ShareVideoReadDeps = {},
): Promise<ShareVideoReadOutcome> {
  const ref = classifyShareVideoUrl(rawUrl);
  if (!ref) return { ok: false, error: "not_video" };

  const now = deps.now ?? Date.now;
  // City affects place suggestions in the prompt, so it is part of both keys.
  const key = `${ref.url}|${viewer.language}|${viewer.cityKey ?? ""}`;
  const cached = cacheGet(key, now());
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = readUncachedVideo(ref, viewer, deps, key, now);
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    if (inFlight.get(key) === work) inFlight.delete(key);
  }
}

async function readUncachedVideo(
  ref: ShareVideoRef,
  viewer: { language: Language; cityKey: string | null },
  deps: ShareVideoReadDeps,
  key: string,
  now: () => number,
): Promise<ShareVideoReadOutcome> {

  const metadataFn = deps.metadata ?? defaultMetadata;
  const meta = await metadataFn(ref).catch(() => null);
  if (!meta) {
    const closed = {
      ok: true as const,
      video: { status: "closed" as const, platform: ref.platform, url: ref.url, questions: [] },
      grounding: {},
    };
    cachePut(key, closed, now());
    return closed;
  }

  const posterUrl = httpsPoster(meta.posterUrl);
  const posterFn = deps.poster ?? defaultPoster;
  const poster = posterUrl ? await posterFn(posterUrl).catch(() => null) : null;

  const analyzeFn = deps.analyze ?? defaultAnalyze;
  const analysis = await analyzeFn({
    platform: ref.platform,
    caption: meta.caption,
    author: meta.author,
    poster: poster ?? undefined,
    language: viewer.language,
    cityKey: viewer.cityKey,
  }).catch(() => null);

  const canonical = meta.ref.url;
  if (analysis && !analysis.safe) {
    // Content we will not repeat back: the sheet says it could not show it.
    const closed = {
      ok: true as const,
      video: { status: "closed" as const, platform: ref.platform, url: canonical, questions: [] },
      grounding: {},
    };
    cachePut(key, closed, now());
    return closed;
  }

  const video: ShareVideo = {
    status: "read",
    platform: ref.platform,
    url: canonical,
    author: meta.author,
    posterUrl,
    title: analysis?.title || titleFromCaption(meta.caption),
    summary: analysis?.summary || undefined,
    interest: analysis?.interest ? { label: analysis.interest } : undefined,
    item: analysis?.item ?? undefined,
    questions: analysis?.questions ?? [],
  };
  const outcome = {
    ok: true as const,
    video,
    grounding: { caption: meta.caption, coverDescription: analysis?.coverDescription || undefined },
  };
  // A model miss is not cached: the next share of the same reel tries again.
  if (analysis) {
    cachePut(key, outcome, now());
    cachePut(`${canonical}|${viewer.language}|${viewer.cityKey ?? ""}`, outcome, now());
  }
  return outcome;
}
