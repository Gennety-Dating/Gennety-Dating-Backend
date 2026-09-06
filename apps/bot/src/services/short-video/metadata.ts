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

/**
 * TikTok publishes an unauthenticated oEmbed endpoint that answers with the
 * caption, the author and a CDN poster URL. It is the cheapest, most stable
 * signal on either platform: no scraping, no HTML shape to track, no login
 * wall.
 */
async function readTikTok(
  ref: ShortVideoRef,
  options: SafeFetchOptions,
): Promise<ShortVideoMetadataResult> {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(ref.url)}`;
  const page = await fetchPlatformPage(endpoint, options);
  if (!page.ok) return { ok: false, error: page.error };

  let payload: TikTokOembed;
  try {
    payload = JSON.parse(page.body) as TikTokOembed;
  } catch {
    return { ok: false, error: "no_metadata" };
  }

  const caption = tidyCaption(
    typeof payload.title === "string" ? payload.title : undefined,
  );
  const posterUrl =
    typeof payload.thumbnail_url === "string" && payload.thumbnail_url
      ? payload.thumbnail_url
      : undefined;
  const authorName =
    typeof payload.author_name === "string" && payload.author_name
      ? payload.author_name.slice(0, 100)
      : undefined;

  if (!caption && !posterUrl) return { ok: false, error: "no_metadata" };
  return { ok: true, ref, metadata: { caption, authorName, posterUrl } };
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
