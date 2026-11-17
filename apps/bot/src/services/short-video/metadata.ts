import {
  fetchPlatformPage,
  resolveRedirect,
  type SafeFetchError,
  type SafeFetchOptions,
} from "./safe-fetch.js";
import { classifyShortVideoUrl, type ShortVideoRef } from "./links.js";

/**
 * The cheap half of understanding a short video: its caption and its poster
 * frame, taken from what the platform publishes about the post.
 *
 * This is the whole cost argument for the feature. A reel's caption is usually
 * the setup and its poster is usually the punchline frame, so one text string
 * and one image reproduce the joke often enough that downloading the video —
 * yt-dlp, a temp file, ffmpeg, Whisper, an async job — buys much less than it
 * costs. Those tiers are deliberately NOT built yet: the ladder above this one
 * should be added when the miss rate says so, not on a hunch.
 *
 * Nothing here is authenticated. We read what a logged-out browser is served,
 * which also fixes the semantics of a private post for free: it simply has no
 * public metadata, and the caller says so instead of guessing.
 */

export interface ShortVideoMetadata {
  /** The author's own caption. Real signal, and often the entire joke. */
  caption: string | undefined;
  authorName: string | undefined;
  /** Absolute URL of the poster frame, on a CDN host `safe-fetch` allows. */
  posterUrl: string | undefined;
}

export type ShortVideoMetadataError = SafeFetchError | "no_metadata";

export type ShortVideoMetadataResult =
  | { ok: true; ref: ShortVideoRef; metadata: ShortVideoMetadata }
  | { ok: false; error: ShortVideoMetadataError };

export type ResolvedRefResult =
  | { ok: true; ref: ShortVideoRef }
  | { ok: false; error: ShortVideoMetadataError };

/** Captions get long; this is prompt context, not an archive. */
const MAX_CAPTION_LEN = 600;

/* ── HTML/entity helpers ────────────────────────────────────────────────── */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known !== undefined) return known;
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/**
 * Read one `<meta>` value by its `property`/`name`. Attribute order is not
 * fixed in real pages, so both orders are tried rather than assumed.
 */
export function readMetaTag(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
      "iu",
    ),
    new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["']`,
      "iu",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]).trim() || undefined;
  }
  return undefined;
}

function tidyCaption(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed ? collapsed.slice(0, MAX_CAPTION_LEN) : undefined;
}

/**
 * Instagram's `og:description` is a stats sentence with the caption quoted
 * inside it: `1,234 likes, 56 comments - user on May 1, 2026: "the caption"`.
 * The counts are noise in a prompt, and worse, they are the kind of detail a
 * model will happily repeat back as if it were the joke.
 */
export function extractQuotedCaption(description: string): string | undefined {
  const quoted = /[:\-–]\s*["“”«]([\s\S]+?)["“”»]\s*\.?\s*$/u.exec(description);
  if (quoted?.[1]) return tidyCaption(quoted[1]);
  const stats = /^[\d.,\sKkMm]+likes?,[^:]*:\s*([\s\S]+)$/u.exec(description);
  if (stats?.[1]) return tidyCaption(stats[1]);
  return tidyCaption(description);
}

/* ── per-platform readers ───────────────────────────────────────────────── */

interface TikTokOembed {
  title?: unknown;
  author_name?: unknown;
  thumbnail_url?: unknown;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string" && item.length > 0);
  return undefined;
}

/**
 * The state JSON of TikTok's public embed page (`/embed/<id>` — the player a
 * blog shows for an embedded TikTok). Exported for tests.
 *
 * Why not oEmbed: by 2026-11 `tiktok.com/oembed` answers every id — real or
 * made up — with a bare skeleton (`embed_product_id`, `embed_type`, no title,
 * no author, no thumbnail). That emptied every TikTok read into `closed`
 * («TikTok didn't show the video»). The embed page is the same logged-out,
 * public surface a third-party site loads, and it still carries the caption
 * (`itemInfos.text`), the cover frames and the author.
 */
export function parseTikTokEmbed(html: string): ShortVideoMetadata | null {
  const match = /<script[^>]+id=["']__FRONTITY_CONNECT_STATE__["'][^>]*>([\s\S]*?)<\/script>/iu.exec(html);
  if (!match?.[1]) return null;
  let state: unknown;
  try {
    state = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const data = (state as { source?: { data?: Record<string, unknown> } })?.source?.data;
  if (!data || typeof data !== "object") return null;
  for (const entry of Object.values(data)) {
    const videoData = (entry as { videoData?: Record<string, unknown> } | null)?.videoData;
    if (!videoData || typeof videoData !== "object") continue;
    const item = (videoData.itemInfos ?? {}) as Record<string, unknown>;
    const author = (videoData.authorInfos ?? {}) as Record<string, unknown>;
    const caption = tidyCaption(typeof item.text === "string" ? item.text : undefined);
    const posterUrl = firstString(item.coversOrigin) ?? firstString(item.covers) ?? firstString(item.coversDynamic);
    const name = firstString(author.nickName) ?? firstString(author.uniqueId);
    if (!caption && !posterUrl) continue;
    return { caption, authorName: name?.slice(0, 100), posterUrl };
  }
  return null;
}

async function readTikTokOembed(
  ref: ShortVideoRef,
  options: SafeFetchOptions,
): Promise<ShortVideoMetadata | null> {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(ref.url)}`;
  const page = await fetchPlatformPage(endpoint, options);
  if (!page.ok) return null;
  let payload: TikTokOembed;
  try {
    payload = JSON.parse(page.body) as TikTokOembed;
  } catch {
    return null;
  }
  const caption = tidyCaption(typeof payload.title === "string" ? payload.title : undefined);
  const posterUrl = firstString(payload.thumbnail_url);
  const authorName = firstString(payload.author_name)?.slice(0, 100);
  if (!caption && !posterUrl) return null;
  return { caption, authorName, posterUrl };
}

/**
 * TikTok: the public embed page first (see `parseTikTokEmbed`), then oEmbed
 * in case TikTok fills it again. No login, no cookies, no token — the same
 * thing any site embedding the video is served.
 */
async function readTikTok(
  ref: ShortVideoRef,
  options: SafeFetchOptions,
): Promise<ShortVideoMetadataResult> {
  if (ref.externalId) {
    const page = await fetchPlatformPage(`https://www.tiktok.com/embed/${ref.externalId}`, options);
    const metadata = page.ok ? parseTikTokEmbed(page.body) : null;
    if (metadata) return { ok: true, ref, metadata };
  }
  const fallback = await readTikTokOembed(ref, options);
  if (!fallback) return { ok: false, error: "no_metadata" };
  return { ok: true, ref, metadata: fallback };
}

/**
 * Instagram has no public oEmbed any more, so the OG tags on the share page
 * are what is left. They are served to logged-out clients often but not
 * always: Meta rate-limits datacenter ranges hard, and a droplet IP that has
 * been asked a few times gets the login wall instead of the tags. That is a
 * `no_metadata`, the caller degrades, and the user is told plainly — it is not
 * something to retry around.
 */
async function readInstagram(
  ref: ShortVideoRef,
  options: SafeFetchOptions,
): Promise<ShortVideoMetadataResult> {
  const page = await fetchPlatformPage(ref.url, options);
  if (!page.ok) return { ok: false, error: page.error };

  const description = readMetaTag(page.body, "og:description");
  const caption = description ? extractQuotedCaption(description) : undefined;
  const posterUrl = readMetaTag(page.body, "og:image");
  const title = readMetaTag(page.body, "og:title");
  const authorName = title ? /^([^\s|·]+)/u.exec(title)?.[1] : undefined;

  if (!caption && !posterUrl) return { ok: false, error: "no_metadata" };
  return {
    ok: true,
    // The share URL may have resolved to the canonical post; prefer the id we
    // can now see over the one we could not.
    ref: classifyShortVideoUrl(page.finalUrl) ?? ref,
    metadata: { caption, authorName, posterUrl },
  };
}

/**
 * Resolve a share stub (`vm.tiktok.com/…`, `instagram.com/share/…`) into a ref
 * that carries the platform's real id, so two people sharing one reel through
 * different buttons collapse onto a single cache entry.
 */
export async function resolveShortVideoRef(
  ref: ShortVideoRef,
  options: SafeFetchOptions = {},
): Promise<ResolvedRefResult> {
  if (ref.externalId) return { ok: true, ref };
  const hop = await resolveRedirect(ref.url, options);
  if (!hop.ok) return { ok: false, error: hop.error };
  const resolved = classifyShortVideoUrl(hop.finalUrl);
  // A stub that lands somewhere we do not recognise (a login wall, the app
  // store, the platform's own "video unavailable" page) has told us the post
  // is not publicly there.
  if (!resolved?.externalId) return { ok: false, error: "not_found" };
  return { ok: true, ref: resolved };
}

/** Caption + poster for one resolved video. */
export async function fetchShortVideoMetadata(
  ref: ShortVideoRef,
  options: SafeFetchOptions = {},
): Promise<ShortVideoMetadataResult> {
  return ref.platform === "tiktok"
    ? readTikTok(ref, options)
    : readInstagram(ref, options);
}
