/**
 * Recognising a TikTok / Instagram Reels link in a message, and reducing it to
 * the one thing worth keying a cache on: the platform's own video id.
 *
 * Pure string work, no network — the redirect hop that some short links need
 * lives in `safe-fetch.ts`, and this module is what decides whether that hop is
 * worth making at all. Kept separate because the URL zoo is the part that
 * actually needs unit tests: every share button on both platforms emits a
 * different shape, and half of them carry tracking that would otherwise fork
 * the cache key for one and the same video.
 *
 * The host list is an ALLOWLIST, not a heuristic. It is also the outer wall of
 * the SSRF perimeter (`safe-fetch.ts` is the inner one): a URL that does not
 * match here is never fetched, so "is this a link we handle" and "is this a
 * link we are willing to open" are deliberately the same question.
 */

export type ShortVideoPlatform = "tiktok" | "instagram";

export interface ShortVideoRef {
  platform: ShortVideoPlatform;
  /**
   * The platform's own id for the video — TikTok's numeric id, Instagram's
   * shortcode. This is the cache key.
   *
   * Null when the link is a share/redirect stub (`vm.tiktok.com/ZM…`,
   * `instagram.com/share/…`) whose id only exists at the other end of a 30x.
   * A null id is the signal to resolve before doing anything else, so two
   * users sharing the same reel through different share buttons still collapse
   * onto one cache entry.
   */
  externalId: string | null;
  /** Tracking-stripped URL to hand the fetcher. */
  url: string;
}

/**
 * Hosts we will open. Suffix-matched against the full hostname, so
 * `www.tiktok.com` and `m.tiktok.com` match `tiktok.com` while
 * `tiktok.com.evil.tld` does not (it would have to *end* with the entry, and
 * the boundary check below requires a `.` before it).
 */
const TIKTOK_HOSTS = ["tiktok.com"] as const;
const INSTAGRAM_HOSTS = ["instagram.com", "instagr.am", "ig.me"] as const;

/**
 * Hosts the poster image may be served from. Separate from the page hosts
 * because the poster URL is read out of a page body — the one value in this
 * whole flow that a third party writes — so it gets its own, tighter wall
 * rather than inheriting "anything on tiktok.com".
 */
const POSTER_HOSTS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "ttwstatic.com",
  "cdninstagram.com",
  "fbcdn.net",
] as const;

/** TikTok ids are 19-digit snowflakes today; the range is generous on purpose. */
const TIKTOK_ID = /^\d{6,25}$/u;
/** Instagram shortcodes are base64url-ish, 5–30 chars in practice. */
const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{5,30}$/u;

/** Query keys that identify the *sharer*, not the video. Dropped from the
 *  canonical URL so they can never reach a log or a cache key. */
const TRACKING_PARAMS = new Set([
  "is_from_webapp",
  "sender_device",
  "sender_web_id",
  "web_id",
  "_r",
  "_t",
  "_d",
  "share_app_id",
  "share_item_id",
  "share_link_id",
  "tt_from",
  "u_code",
  "source",
  "checksum",
  "igsh",
  "igshid",
  "img_index",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
]);

function hostMatches(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return suffixes.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** True when this hostname is one we will open a page on. */
export function isShortVideoHost(hostname: string): boolean {
  return (
    hostMatches(hostname, TIKTOK_HOSTS) || hostMatches(hostname, INSTAGRAM_HOSTS)
  );
}

/** True when this hostname is one we will download a poster image from. */
export function isPosterHost(hostname: string): boolean {
  return hostMatches(hostname, POSTER_HOSTS);
}

function stripTracking(url: URL): string {
  const clean = new URL(url.toString());
  clean.hash = "";
  for (const key of [...clean.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) clean.searchParams.delete(key);
  }
  // A trailing "?" left by deleting every param reads as a different URL to a
  // cache and to a human, and means nothing to either platform.
  clean.search = clean.searchParams.toString();
  return clean.toString();
}

/**
 * Classify one already-parsed URL.
 *
 * Returns null for anything off-platform, and for on-platform URLs that are
 * not a single piece of video content (a profile, the discover feed, a
 * hashtag) — those are links a person may well paste, but there is nothing to
 * describe behind them.
 */
export function classifyShortVideoUrl(raw: string): ShortVideoRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // Segments, minus the empty ones a trailing slash leaves behind.
  const seg = url.pathname.split("/").filter(Boolean);

  if (hostMatches(url.hostname, TIKTOK_HOSTS)) {
    const host = url.hostname.toLowerCase();
    // vm./vt. are pure redirect stubs: the whole path is an opaque token.
    if (host.startsWith("vm.") || host.startsWith("vt.")) {
      return seg.length === 1
        ? { platform: "tiktok", externalId: null, url: stripTracking(url) }
        : null;
    }
    // /t/<token> is the same stub on the main host.
    if (seg[0] === "t" && seg.length === 2) {
      return { platform: "tiktok", externalId: null, url: stripTracking(url) };
    }
    // /@user/video/<id> and the photo-mode twin /@user/photo/<id>.
    if (
      seg.length >= 3 &&
      seg[0]!.startsWith("@") &&
      (seg[1] === "video" || seg[1] === "photo") &&
      TIKTOK_ID.test(seg[2]!)
    ) {
      return {
        platform: "tiktok",
        externalId: seg[2]!,
        url: stripTracking(url),
      };
    }
    // Legacy mobile shape: /v/<id>.html
    if (seg[0] === "v" && seg.length === 2) {
      const id = seg[1]!.replace(/\.html$/u, "");
      if (TIKTOK_ID.test(id)) {
        return { platform: "tiktok", externalId: id, url: stripTracking(url) };
      }
    }
    return null;
  }

  if (hostMatches(url.hostname, INSTAGRAM_HOSTS)) {
    // The 2024-era share links (/share/reel/<token>) resolve to the real
    // shortcode; the token itself is not one.
    if (seg[0] === "share") {
      return seg.length >= 2
        ? { platform: "instagram", externalId: null, url: stripTracking(url) }
        : null;
    }
    if (
      seg.length >= 2 &&
      (seg[0] === "reel" || seg[0] === "reels" || seg[0] === "p" || seg[0] === "tv") &&
      INSTAGRAM_SHORTCODE.test(seg[1]!)
    ) {
      return {
        platform: "instagram",
        externalId: seg[1]!,
        url: stripTracking(url),
      };
    }
    // /<user>/reel/<code> — the shape the app's own copy-link produces.
    if (
      seg.length >= 3 &&
      (seg[1] === "reel" || seg[1] === "reels" || seg[1] === "p") &&
      INSTAGRAM_SHORTCODE.test(seg[2]!)
    ) {
      return {
        platform: "instagram",
        externalId: seg[2]!,
        url: stripTracking(url),
      };
    }
    return null;
  }

  return null;
}

/**
 * The first short-video link in a message, if any.
 *
 * Scans for bare URLs rather than requiring the message to *be* one: people
 * routinely send "вот это меня убивает <link>", and that surrounding sentence
 * is real signal about why they find it funny — the caller keeps it and passes
 * it to the vision pass exactly as it passes a photo's caption.
 */
export function findShortVideoLink(text: string): ShortVideoRef | null {
  // Trailing ) . , ! ? » and friends are punctuation around the link far more
  // often than part of it.
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const trimmed = match[0].replace(/[).,!?;:»"'\]]+$/u, "");
    const ref = classifyShortVideoUrl(trimmed);
    if (ref) return ref;
  }
  return null;
}

/**
 * The user's own words around the link — everything but the URL itself.
 *
 * Empty string when they sent nothing but the link. Capped because this is
 * caption-grade context for a prompt, not a document.
 */
export function commentaryAroundLink(text: string): string | undefined {
  const stripped = text.replace(/https?:\/\/[^\s<>"']+/giu, " ").trim();
  const collapsed = stripped.replace(/\s+/gu, " ");
  return collapsed ? collapsed.slice(0, 300) : undefined;
}
