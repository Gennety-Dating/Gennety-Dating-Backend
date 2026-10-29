import {
  classifyShortVideoUrl,
  isPosterHost,
  isShortVideoHost,
  type ShortVideoRef,
} from "../short-video/links.js";

/**
 * Which shared links the iOS share sheet treats as a short video (decision
 * journal 2026-10-24): the Profiler's TikTok / Instagram set plus YouTube.
 *
 * YouTube lives HERE and not in `short-video/links.ts` on purpose: the
 * Profiler's classifier and its SSRF wall stay exactly as they were (its test
 * still asserts a Shorts link is not a video). This module wraps them and
 * passes its own, wider allowlist to the `fetchAllowlisted*` fetches.
 */

export type ShareVideoPlatform = "tiktok" | "instagram" | "youtube";

export interface ShareVideoRef {
  platform: ShareVideoPlatform;
  /** Platform id; null for a TikTok / Instagram share stub that needs a hop. */
  externalId: string | null;
  /** Tracking-stripped canonical URL — also the cache key. */
  url: string;
}

const YOUTUBE_PAGE_HOSTS = ["youtube.com", "youtu.be"] as const;
/** Thumbnails: `i.ytimg.com` (and the `i9.` / `img.` twins). */
const YOUTUBE_POSTER_HOSTS = ["ytimg.com"] as const;
/** YouTube video ids are 11 chars today; the range leaves room. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/u;

function hostMatches(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Pages the share sheet will open: the Profiler's hosts plus YouTube. */
export function isShareVideoHost(hostname: string): boolean {
  return isShortVideoHost(hostname) || hostMatches(hostname, YOUTUBE_PAGE_HOSTS);
}

/** Poster CDNs the share sheet will download from and hand to the app. */
export function isSharePosterHost(hostname: string): boolean {
  return isPosterHost(hostname) || hostMatches(hostname, YOUTUBE_POSTER_HOSTS);
}

function fromShortVideo(ref: ShortVideoRef): ShareVideoRef {
  return { platform: ref.platform, externalId: ref.externalId, url: ref.url };
}

function classifyYouTube(url: URL): ShareVideoRef | null {
  if (!hostMatches(url.hostname, YOUTUBE_PAGE_HOSTS)) return null;
  const seg = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  let shorts = false;
  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    id = seg.length === 1 ? seg[0] : undefined;
  } else if (seg[0] === "shorts" && seg.length >= 2) {
    id = seg[1];
    shorts = true;
  } else if (seg.length === 1 && seg[0] === "watch") {
    id = url.searchParams.get("v") ?? undefined;
  }
  if (!id || !YOUTUBE_ID.test(id)) return null;
  return {
    platform: "youtube",
    externalId: id,
    // Canonical shape regardless of the button that produced the link, so
    // `youtu.be/x?si=…` and `youtube.com/watch?v=x` share one cache entry.
    url: shorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
  };
}

/** A shared URL → video ref, or null when it is not one video we read. */
export function classifyShareVideoUrl(raw: string): ShareVideoRef | null {
  const short = classifyShortVideoUrl(raw);
  if (short) return fromShortVideo(short);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return classifyYouTube(url);
}
