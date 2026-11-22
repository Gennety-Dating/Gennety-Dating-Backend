/**
 * Which shared links the iOS share sheet reads as MUSIC — a playlist, an
 * album or one track (decision 2026-11-22). Everything here is a pure
 * function of the URL: no network, no guessing from page bodies.
 *
 * Plain YouTube videos (`youtube.com/watch`, `youtu.be`, Shorts) are NOT music
 * here, on purpose: they stay with the short-video read (`share-video/links.ts`).
 * Only a YouTube *playlist* page and anything on `music.youtube.com` is music.
 */

export type ShareMusicSource =
  | "youtube_music"
  | "youtube"
  | "spotify"
  | "apple_music"
  | "yandex_music"
  | "soundcloud";

export type ShareMusicKind = "playlist" | "album" | "track";

export interface ShareMusicRef {
  source: ShareMusicSource;
  kind: ShareMusicKind;
  /** The provider's id; null for a short-link stub that needs one hop. */
  id: string | null;
  /** Tracking-stripped canonical URL — also the cache key. */
  url: string;
  /** Apple Music only: the storefront in the link (`us`, `ua`, …). */
  storefront?: string | undefined;
  /** Yandex Music only: a classic playlist's owner login (`/users/<owner>/playlists/<kind>`). */
  owner?: string | undefined;
}

function hostMatches(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const YOUTUBE_HOSTS = ["youtube.com"] as const;
const SPOTIFY_HOSTS = ["open.spotify.com"] as const;
const SPOTIFY_SHORT_HOSTS = ["spotify.link", "spoti.fi"] as const;
/** Exact hosts: `api.music.apple.com` is the keyed API, reached only by `apple-music.ts`. */
const APPLE_MUSIC_HOSTS = ["music.apple.com", "embed.music.apple.com"] as const;
/** Yandex Music country sites; the API host is ours to build, never a client's. */
const YANDEX_MUSIC_HOST = /^music\.yandex\.(?:ru|com|by|kz|uz)$/u;
const YANDEX_API_HOSTS = ["api.music.yandex.net"] as const;
const SOUNDCLOUD_HOSTS = ["soundcloud.com"] as const;
const SOUNDCLOUD_SHORT_HOSTS = ["on.soundcloud.com"] as const;

/**
 * Hosts the music read may open — for the page, the redirect hops and the
 * provider JSON it builds. Covers are never downloaded by the server: the
 * client draws the provider's own CDN URL.
 */
export function isShareMusicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    hostMatches(host, YOUTUBE_HOSTS) ||
    hostMatches(host, SPOTIFY_HOSTS) ||
    hostMatches(host, SPOTIFY_SHORT_HOSTS) ||
    (APPLE_MUSIC_HOSTS as readonly string[]).includes(host) ||
    YANDEX_MUSIC_HOST.test(host) ||
    hostMatches(host, YANDEX_API_HOSTS) ||
    hostMatches(host, SOUNDCLOUD_HOSTS)
  );
}

/** YouTube playlist ids (`PL…`, `OLAK5uy_…` albums, `RDCLAK5uy_…`); `WL` / `LL` are private. */
const YOUTUBE_LIST = /^[A-Za-z0-9_-]{10,80}$/u;
const YOUTUBE_VIDEO = /^[A-Za-z0-9_-]{6,20}$/u;
/** A YouTube Music album page: `browse/MPREb_…`. */
const YOUTUBE_MUSIC_ALBUM = /^MPREb_[A-Za-z0-9_-]{6,40}$/u;
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/u;
const APPLE_PLAYLIST_ID = /^pl\.[A-Za-z0-9-]{8,80}$/u;
const APPLE_NUMERIC_ID = /^[0-9]{1,20}$/u;
const STOREFRONT = /^[a-z]{2}$/u;
const YANDEX_NUMERIC_ID = /^[0-9]{1,15}$/u;
const YANDEX_LOGIN = /^[A-Za-z0-9._-]{1,64}$/u;
/** New-style Yandex playlists: `/playlists/<uuid>` or `/playlists/lk.<uuid>`. */
const YANDEX_PLAYLIST_UUID = /^(?:lk\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SOUNDCLOUD_SLUG = /^[A-Za-z0-9_-]{1,100}$/u;
/** First path segments of soundcloud.com that are app pages, not a user. */
const SOUNDCLOUD_RESERVED_USER = new Set([
  "discover", "search", "you", "stations", "charts", "upload", "pages", "terms-of-use",
  "settings", "messages", "notifications", "feed", "people", "mobile", "jobs", "imprint",
]);
/** Second segments under a user that are lists of theirs, not one track. */
const SOUNDCLOUD_RESERVED_TRACK = new Set([
  "sets", "tracks", "albums", "likes", "reposts", "popular-tracks", "followers", "following",
  "comments", "spotlight", "playlists",
]);

function classifyYouTube(url: URL): ShareMusicRef | null {
  if (!hostMatches(url.hostname, YOUTUBE_HOSTS)) return null;
  const music = url.hostname.toLowerCase().replace(/\.$/u, "") === "music.youtube.com";
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg.length === 1 && seg[0] === "playlist") {
    const list = url.searchParams.get("list") ?? "";
    if (!YOUTUBE_LIST.test(list)) return null;
    return {
      source: music ? "youtube_music" : "youtube",
      // YouTube Music's album playlists all start `OLAK5uy_`.
      kind: list.startsWith("OLAK5uy_") ? "album" : "playlist",
      id: list,
      url: `https://${music ? "music" : "www"}.youtube.com/playlist?list=${list}`,
    };
  }
  if (!music) return null; // a plain YouTube video is the short-video read's
  if (seg.length === 1 && seg[0] === "watch") {
    const video = url.searchParams.get("v") ?? "";
    if (!YOUTUBE_VIDEO.test(video)) return null;
    return {
      source: "youtube_music",
      kind: "track",
      id: video,
      url: `https://music.youtube.com/watch?v=${video}`,
    };
  }
  if (seg.length === 2 && seg[0] === "browse" && YOUTUBE_MUSIC_ALBUM.test(seg[1]!)) {
    return {
      source: "youtube_music",
      kind: "album",
      id: seg[1]!,
      url: `https://music.youtube.com/browse/${seg[1]}`,
    };
  }
  return null;
}

function classifySpotify(url: URL): ShareMusicRef | null {
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split("/").filter(Boolean);
  if (hostMatches(host, SPOTIFY_SHORT_HOSTS)) {
    if (seg.length !== 1 || !/^[A-Za-z0-9]{3,30}$/u.test(seg[0]!)) return null;
    return { source: "spotify", kind: "playlist", id: null, url: `https://${host}/${seg[0]}` };
  }
  if (!hostMatches(host, SPOTIFY_HOSTS)) return null;
  // `/intl-de/playlist/…` and `/embed/playlist/…` are the same entity.
  const rest = seg.filter((part, index) => !(index === 0 && (/^intl-[a-z]{2}(?:-[a-z]{2})?$/iu.test(part) || part === "embed")));
  if (rest.length < 2) return null;
  const [type, id] = rest as [string, string];
  if (!SPOTIFY_ID.test(id)) return null;
  if (type !== "playlist" && type !== "album" && type !== "track") return null;
  return { source: "spotify", kind: type, id, url: `https://open.spotify.com/${type}/${id}` };
}

function classifyAppleMusic(url: URL): ShareMusicRef | null {
  if (!(APPLE_MUSIC_HOSTS as readonly string[]).includes(url.hostname.toLowerCase().replace(/\.$/u, ""))) return null;
  const seg = url.pathname.split("/").filter(Boolean);
  const storefront = seg[0]?.toLowerCase();
  if (!storefront || !STOREFRONT.test(storefront) || seg.length < 3) return null;
  const type = seg[1];
  const id = seg[seg.length - 1]!;
  if (type === "playlist" && APPLE_PLAYLIST_ID.test(id)) {
    return {
      source: "apple_music",
      kind: "playlist",
      id,
      url: `https://music.apple.com/${storefront}/playlist/${id}`,
      storefront,
    };
  }
  if (type === "album" && APPLE_NUMERIC_ID.test(id)) {
    // «Share song» in Apple Music gives the album page with `?i=<song id>`.
    const song = url.searchParams.get("i");
    if (song && APPLE_NUMERIC_ID.test(song)) {
      return {
        source: "apple_music",
        kind: "track",
        id: song,
        url: `https://music.apple.com/${storefront}/song/${song}`,
        storefront,
      };
    }
    return {
      source: "apple_music",
      kind: "album",
      id,
      url: `https://music.apple.com/${storefront}/album/${id}`,
      storefront,
    };
  }
  if (type === "song" && APPLE_NUMERIC_ID.test(id)) {
    return {
      source: "apple_music",
      kind: "track",
      id,
      url: `https://music.apple.com/${storefront}/song/${id}`,
      storefront,
    };
  }
  return null;
}

function classifyYandex(url: URL): ShareMusicRef | null {
  if (!YANDEX_MUSIC_HOST.test(url.hostname.toLowerCase().replace(/\.$/u, ""))) return null;
  const seg = url.pathname.split("/").filter(Boolean);
  const base = "https://music.yandex.ru";
  if (seg[0] === "album" && seg[1] && YANDEX_NUMERIC_ID.test(seg[1])) {
    if (seg[2] === "track" && seg[3] && YANDEX_NUMERIC_ID.test(seg[3])) {
      return { source: "yandex_music", kind: "track", id: seg[3], url: `${base}/album/${seg[1]}/track/${seg[3]}` };
    }
    if (seg.length === 2) {
      return { source: "yandex_music", kind: "album", id: seg[1], url: `${base}/album/${seg[1]}` };
    }
    return null;
  }
  if (seg[0] === "track" && seg.length === 2 && YANDEX_NUMERIC_ID.test(seg[1]!)) {
    return { source: "yandex_music", kind: "track", id: seg[1]!, url: `${base}/track/${seg[1]}` };
  }
  if (
    seg[0] === "users" &&
    seg[2] === "playlists" &&
    seg.length === 4 &&
    YANDEX_LOGIN.test(seg[1]!) &&
    YANDEX_NUMERIC_ID.test(seg[3]!)
  ) {
    return {
      source: "yandex_music",
      kind: "playlist",
      id: seg[3]!,
      owner: seg[1]!,
      url: `${base}/users/${seg[1]}/playlists/${seg[3]}`,
    };
  }
  if (seg[0] === "playlists" && seg.length === 2 && YANDEX_PLAYLIST_UUID.test(seg[1]!)) {
    return { source: "yandex_music", kind: "playlist", id: seg[1]!, url: `${base}/playlists/${seg[1]}` };
  }
  return null;
}

function classifySoundCloud(url: URL): ShareMusicRef | null {
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const seg = url.pathname.split("/").filter(Boolean);
  if (hostMatches(host, SOUNDCLOUD_SHORT_HOSTS)) {
    if (seg.length !== 1 || !/^[A-Za-z0-9]{3,30}$/u.test(seg[0]!)) return null;
    return { source: "soundcloud", kind: "playlist", id: null, url: `https://on.soundcloud.com/${seg[0]}` };
  }
  if (!hostMatches(host, SOUNDCLOUD_HOSTS)) return null;
  if (!seg.every((part) => SOUNDCLOUD_SLUG.test(part))) return null;
  const [user, second, third] = seg;
  if (!user || SOUNDCLOUD_RESERVED_USER.has(user.toLowerCase())) return null;
  if (second === "sets" && third && seg.length === 3) {
    return {
      source: "soundcloud",
      kind: "playlist",
      id: `${user}/sets/${third}`,
      url: `https://soundcloud.com/${user}/sets/${third}`,
    };
  }
  if (second && seg.length === 2 && !SOUNDCLOUD_RESERVED_TRACK.has(second.toLowerCase())) {
    return { source: "soundcloud", kind: "track", id: `${user}/${second}`, url: `https://soundcloud.com/${user}/${second}` };
  }
  return null;
}

/** A shared URL → music ref, or null when it is not a playlist, album or track we read. */
export function classifyShareMusicUrl(raw: string): ShareMusicRef | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || (url.port && url.port !== "443" && url.port !== "80")) return null;
  return (
    classifyYouTube(url) ??
    classifySpotify(url) ??
    classifyAppleMusic(url) ??
    classifyYandex(url) ??
    classifySoundCloud(url)
  );
}

