import type { MusicTrackRef } from "../music/profile-music.js";
import { isHttpsUrl } from "../music/track.js";

/**
 * Pure readers of what a logged-out browser is served for a playlist, an album
 * or a track (decision 2026-11-22). No network and no model here — every
 * function takes a page or a JSON body and returns plain data, so each provider
 * is tested against a saved response.
 *
 * NOTHING read here goes to a model. Music on the profile is display-only by
 * the Spotify Developer Policy (see the `ProfileMusicTrack` model comment), and
 * a playlist is exactly "music taste"; `share-music.boundary.test.ts` holds it.
 */

/** One entry of the shared list, as the source describes it. */
export interface SourceTrack {
  title: string;
  /** Artist names joined with ", "; "" when the source did not say. */
  artists: string;
  albumName: string | null;
  coverUrl: string | null;
  /** The track on the source, when it has its own page. */
  sourceUrl: string | null;
  /** Set when the source IS a profile provider and gave its catalogue id. */
  ref: MusicTrackRef | null;
}

export interface SourcePage {
  title: string | null;
  /** Owner of a playlist, artist of an album. */
  author: string | null;
  coverUrl: string | null;
  /** How many tracks the provider says the list has; null when it did not say. */
  total: number | null;
  tracks: SourceTrack[];
  /** Entries listed but not described (SoundCloud stubs, Yandex id-only rows). */
  unreadable: number;
}

/* ── small helpers ──────────────────────────────────────────────────────── */

const TEXT_MAX = 200;

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, TEXT_MAX) : null;
}

function https(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.startsWith("//") ? `https:${value}` : value;
  return isHttpsUrl(url) ? url : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function count(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string") {
    const digits = value.replace(/[\s,.\u00a0\u202f]/gu, "").match(/\d+/u)?.[0];
    return digits ? Number(digits) : null;
  }
  return null;
}

function names(value: unknown): string {
  return list(value)
    .map((entry) => str(record(entry)?.name) ?? str(entry))
    .filter((name): name is string => Boolean(name))
    .join(", ");
}

/** Depth-first walk of a JSON tree, calling `visit` on every object. */
function walk(node: unknown, visit: (object: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 60 || typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1);
    return;
  }
  const object = node as Record<string, unknown>;
  visit(object);
  for (const child of Object.values(object)) walk(child, visit, depth + 1);
}

function parseJson(text: string | undefined | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&#x27;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

/** `<meta property="og:title" content="…">` in either attribute order. */
export function metaContent(html: string, property: string): string | null {
  const name = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "iu");
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "iu");
  const raw = a.exec(html)?.[1] ?? b.exec(html)?.[1];
  return raw ? str(decodeEntities(raw)) : null;
}

/* ── Spotify: the embed player's page data ──────────────────────────────── */

/**
 * `open.spotify.com/embed/{playlist|album|track}/<id>` carries the whole list
 * in `__NEXT_DATA__` — the data the embeddable player draws, no key needed.
 * Tracks come with Spotify ids, so they need no matching; only covers are
 * per album, and an embed track row has none.
 */
export function parseSpotifyEmbed(html: string): SourcePage | null {
  const raw = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/iu.exec(html)?.[1];
  const data = parseJson(raw);
  let entity: Record<string, unknown> | null = null;
  walk(data, (object) => {
    if (!entity && (Array.isArray(object.trackList) || (object.type === "track" && typeof object.uri === "string"))) {
      entity = object;
    }
  });
  const found = entity as Record<string, unknown> | null;
  if (!found) return null;

  const sources = list(record(found.coverArt)?.sources)
    .map((source) => record(source))
    .filter((source): source is Record<string, unknown> => source !== null)
    .sort((a, b) => Math.abs(Number(a.width ?? 0) - 300) - Math.abs(Number(b.width ?? 0) - 300));
  const cover = https(sources[0]?.url) ?? https(record(record(found.visualIdentity)?.image)?.url);
  const album = found.type === "album" ? str(found.name) ?? str(found.title) : null;

  const rows = Array.isArray(found.trackList)
    ? found.trackList
    : [{ uri: found.uri, title: found.name ?? found.title, subtitle: names(found.artists) || found.subtitle }];
  const tracks: SourceTrack[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const entry = record(row);
    const id = /^spotify:track:([0-9A-Za-z]{22})$/u.exec(String(entry?.uri ?? ""))?.[1];
    const title = str(entry?.title);
    if (!id || !title) {
      // Episodes, local files and unavailable rows have no track id.
      unreadable += 1;
      continue;
    }
    tracks.push({
      title,
      artists: str(entry?.subtitle) ?? "",
      albumName: album,
      // An album's rows share its cover; a playlist row is given one later.
      coverUrl: found.type === "album" ? cover : null,
      sourceUrl: `https://open.spotify.com/track/${id}`,
      ref: { provider: "spotify", trackId: id },
    });
  }
  return {
    title: str(found.name) ?? str(found.title),
    author: str(found.subtitle) ?? (names(found.artists) || null),
    coverUrl: cover,
    total: Array.isArray(found.trackList) ? found.trackList.length : 1,
    tracks,
    unreadable,
  };
}

/* ── YouTube / YouTube Music ────────────────────────────────────────────── */

/** Video labels that are not part of a song's name. */
const YOUTUBE_NOISE =
  /\s*[([【]\s*(?:official|офиц|video|видео|audio|аудио|lyrics?|lyric video|текст|visuali[sz]er|hd|hq|4k|mv|m\/v|clip|клип|премьера|premiere|explicit|color coded)[^)\]】]*[)\]】]/giu;

/**
 * A YouTube row → song and artist. A «Artist - Topic» channel is YouTube
 * Music's own catalogue upload: its title IS the song. Otherwise uploads are
 * usually «Artist - Song (Official Video)»; failing that the channel is the
 * best guess for the artist.
 */
export function splitYouTubeTitle(title: string, channel: string | null): { title: string; artists: string } {
  const clean = (text: string) => text.replace(YOUTUBE_NOISE, "").replace(/\s*\|.*$/u, "").replace(/\s+/gu, " ").trim();
  const owner = (channel ?? "").replace(/\s+-\s+Topic$/iu, "").replace(/VEVO$/u, "").replace(/\s*-?\s*Official$/iu, "").trim();
  if (channel && /\s-\sTopic$/iu.test(channel)) return { title: clean(title) || title, artists: owner };
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(clean(title));
  if (dash) {
    // «Artist - Song ft. Guest»: the guest is an artist, not part of the name.
    const song = dash[2]!.replace(/^["«“]|["»”]$/gu, "").trim();
    const feat = /^(.+?)\s+(?:ft\.?|feat\.?|featuring)\s+(.+)$/iu.exec(song);
    return feat
      ? { title: feat[1]!.trim(), artists: `${dash[1]!.trim()}, ${feat[2]!.trim()}` }
      : { title: song, artists: dash[1]!.trim() };
  }
  return { title: clean(title) || title, artists: owner };
}

function runsText(value: unknown): string | null {
  const object = record(value);
  if (!object) return null;
  return str(object.simpleText) ?? str(list(object.runs).map((run) => record(run)?.text ?? "").join(""));
}

/** `var ytInitialData = {…};` out of a youtube.com page. */
function ytInitialData(html: string): unknown {
  const marker = /ytInitialData\s*=\s*/u.exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  const end = html.indexOf(";</script>", start);
  return parseJson(end > start ? html.slice(start, end) : null);
}

/**
 * `www.youtube.com/playlist?list=<id>` — the first page of the list (about
 * 100 rows) is in `ytInitialData` as `playlistVideoRenderer`s. The walk does
 * not depend on where YouTube nests them this year.
 */
export function parseYouTubePlaylist(html: string): SourcePage | null {
  const data = ytInitialData(html);
  if (!data) return null;
  const tracks: SourceTrack[] = [];
  let unreadable = 0;
  // Filled inside the walk; an object so TypeScript does not narrow them to null.
  const head: { title: string | null; author: string | null; total: number | null } = {
    title: null,
    author: null,
    total: null,
  };
  walk(data, (object) => {
    const row = record(object.playlistVideoRenderer);
    if (row) {
      const videoId = typeof row.videoId === "string" && /^[A-Za-z0-9_-]{6,20}$/u.test(row.videoId) ? row.videoId : null;
      const name = runsText(row.title);
      // Deleted and private videos keep a row with no channel line.
      if (!videoId || !name || row.isPlayable === false) {
        unreadable += 1;
        return;
      }
      const song = splitYouTubeTitle(name, runsText(row.shortBylineText));
      tracks.push({
        title: song.title,
        artists: song.artists,
        albumName: null,
        coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        sourceUrl: `https://music.youtube.com/watch?v=${videoId}`,
        ref: null,
      });
    }
    const meta = record(object.playlistMetadataRenderer);
    if (meta) head.title ??= str(meta.title);
    const header = record(object.playlistHeaderRenderer);
    if (header) {
      head.title ??= runsText(header.title);
      head.author ??= runsText(header.ownerText);
      head.total ??= count(runsText(header.numVideosText)) ?? count(runsText(list(header.stats)[0]));
    }
  });
  if (tracks.length === 0 && unreadable === 0) return null;
  return {
    title: head.title ?? metaContent(html, "og:title"),
    author: head.author ? head.author.replace(/^by\s+/iu, "") : null,
    coverUrl: https(metaContent(html, "og:image")) ?? tracks[0]?.coverUrl ?? null,
    total: head.total,
    tracks,
    unreadable,
  };
}

/** YouTube's public oEmbed for one `watch?v=` — a YouTube Music track link. */
export function parseYouTubeOembed(body: string, videoId: string): SourcePage | null {
  const payload = record(parseJson(body));
  const name = str(payload?.title);
  if (!name) return null;
  const song = splitYouTubeTitle(name, str(payload?.author_name));
  const cover = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  return {
    title: song.title,
    author: song.artists || null,
    coverUrl: cover,
    total: 1,
    tracks: [
      {
        title: song.title,
        artists: song.artists,
        albumName: null,
        coverUrl: cover,
        sourceUrl: `https://music.youtube.com/watch?v=${videoId}`,
        ref: null,
      },
    ],
    unreadable: 0,
  };
}

/**
 * A YouTube Music album page (`browse/MPREb_…`) is a script app, but its
 * escaped initial data names the album's playlist (`OLAK5uy_…`), which
 * youtube.com serves as an ordinary playlist page.
 */
export function findYouTubeAlbumPlaylist(html: string): string | null {
  const decoded = html.replace(/\\x([0-9a-fA-F]{2})/gu, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return /\b(OLAK5uy_[A-Za-z0-9_-]{20,60})/u.exec(decoded)?.[1] ?? null;
}

/* ── Apple Music (no key): the page's schema.org data ───────────────────── */

/**
 * Any `<script type="application/ld+json">` describing a MusicPlaylist,
 * MusicAlbum or MusicRecording — Apple Music pages carry one, as do other
 * catalogue sites. The fallback when a provider's own data is not reachable.
 */
export function parseMusicLdJson(html: string): SourcePage | null {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)];
  for (const block of blocks) {
    let collection: Record<string, unknown> | null = null;
    walk(parseJson(block[1]), (object) => {
      const type = String(object["@type"] ?? "");
      if (!collection && /^(?:MusicPlaylist|MusicAlbum|MusicRecording)$/u.test(type)) collection = object;
    });
    const found = collection as Record<string, unknown> | null;
    if (!found) continue;
    const type = String(found["@type"]);
    const albumName = type === "MusicAlbum" ? str(found.name) : null;
    const byArtist = (value: unknown) => names(Array.isArray(value) ? value : [value]);
    const image = (value: unknown) => https(Array.isArray(value) ? value[0] : record(value)?.url ?? value);
    const cover = image(found.image);
    const rows =
      type === "MusicRecording"
        ? [found]
        : list(found.track ?? found.tracks).flatMap((entry) => {
            const itemList = record(entry);
            if (itemList && Array.isArray(itemList.itemListElement)) {
              return itemList.itemListElement.map((element) => record(element)?.item ?? element);
            }
            return [entry];
          });
    const tracks: SourceTrack[] = [];
    let unreadable = 0;
    for (const row of rows) {
      const entry = record(row);
      const title = str(entry?.name);
      if (!entry || !title) {
        unreadable += 1;
        continue;
      }
      tracks.push({
        title,
        artists: byArtist(entry.byArtist) || (type === "MusicAlbum" ? byArtist(found.byArtist) : ""),
        albumName: str(record(entry.inAlbum)?.name) ?? albumName,
        coverUrl: image(entry.image) ?? cover,
        sourceUrl: https(entry.url),
        ref: null,
      });
    }
    if (tracks.length === 0) continue;
    return {
      title: str(found.name),
      author: byArtist(found.byArtist ?? found.author) || null,
      coverUrl: cover,
      total: count(found.numTracks) ?? rows.length,
      tracks,
      unreadable,
    };
  }
  return null;
}

/* ── Yandex Music: the public JSON API ──────────────────────────────────── */

function yandexCover(uri: unknown): string | null {
  return typeof uri === "string" && uri.includes("%%") ? https(`https://${uri.replace("%%", "300x300")}`) : null;
}

function yandexTrack(raw: unknown, fallbackCover: string | null): SourceTrack | null {
  const track = record(raw);
  const base = str(track?.title);
  if (!track || !base || track.available === false) return null;
  const version = str(track.version);
  const album = record(list(track.albums)[0]);
  const id = String(track.id ?? "");
  return {
    title: version ? `${base} (${version})` : base,
    artists: names(track.artists),
    albumName: str(album?.title),
    coverUrl: yandexCover(track.coverUri) ?? yandexCover(album?.coverUri) ?? fallbackCover,
    sourceUrl:
      /^\d+$/u.test(id) && album?.id !== undefined
        ? `https://music.yandex.ru/album/${String(album.id)}/track/${id}`
        : null,
    ref: null,
  };
}

/**
 * `api.music.yandex.net` answers anonymously for public albums, playlists and
 * tracks: `{ result: … }` with an album's `volumes`, a playlist's `tracks`
 * (each `{ track }`, or a bare id without it) or a list of tracks.
 */
export function parseYandexMusic(body: string): SourcePage | null {
  const result = record(parseJson(body))?.result;
  if (Array.isArray(result)) {
    const tracks = result.map((track) => yandexTrack(track, null)).filter((t): t is SourceTrack => t !== null);
    if (tracks.length === 0) return null;
    return { title: tracks[0]!.title, author: tracks[0]!.artists || null, coverUrl: tracks[0]!.coverUrl, total: 1, tracks, unreadable: 0 };
  }
  const object = record(result);
  if (!object) return null;
  const cover = yandexCover(object.coverUri) ?? yandexCover(record(object.cover)?.uri) ?? yandexCover(object.ogImage);
  const rows: unknown[] = Array.isArray(object.volumes)
    ? object.volumes.flatMap((volume) => list(volume))
    : list(object.tracks).map((entry) => record(entry)?.track ?? null);
  const tracks: SourceTrack[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const track = yandexTrack(row, cover);
    if (track) tracks.push(track);
    else unreadable += 1;
  }
  if (tracks.length === 0 && unreadable === 0) return null;
  return {
    title: str(object.title),
    author: names(object.artists) || str(record(object.owner)?.name) || str(record(object.owner)?.login),
    coverUrl: cover,
    total: count(object.trackCount) ?? rows.length,
    tracks,
    unreadable,
  };
}

/* ── SoundCloud: the page's hydration data ──────────────────────────────── */

function soundcloudArtwork(value: unknown): string | null {
  return typeof value === "string" ? https(value.replace("-large.", "-t300x300.")) : null;
}

function soundcloudTrack(raw: unknown, fallbackCover: string | null): SourceTrack | null {
  const track = record(raw);
  const title = str(track?.title);
  if (!track || !title) return null;
  const artist = str(record(track.publisher_metadata)?.artist) ?? str(record(track.user)?.username) ?? "";
  return {
    title,
    artists: artist,
    albumName: str(record(track.publisher_metadata)?.album_title),
    coverUrl: soundcloudArtwork(track.artwork_url) ?? fallbackCover,
    sourceUrl: https(track.permalink_url),
    ref: null,
  };
}

/**
 * `window.__sc_hydration = [...]` on a set or track page. A set describes its
 * first few tracks in full; the rest are id-only stubs that only SoundCloud's
 * keyed API resolves, so they are counted as `unreadable`, never guessed.
 */
export function parseSoundCloud(html: string): SourcePage | null {
  const raw = /__sc_hydration\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/u.exec(html)?.[1];
  const entries = list(parseJson(raw)).map((entry) => record(entry));
  const playlist = entries.find((entry) => entry?.hydratable === "playlist")?.data;
  const sound = entries.find((entry) => entry?.hydratable === "sound")?.data;
  const set = record(playlist);
  if (set) {
    const cover = soundcloudArtwork(set.artwork_url);
    const tracks: SourceTrack[] = [];
    let unreadable = 0;
    for (const row of list(set.tracks)) {
      const track = soundcloudTrack(row, cover);
      if (track) tracks.push(track);
      else unreadable += 1;
    }
    return {
      title: str(set.title),
      author: str(record(set.user)?.username),
      coverUrl: cover ?? tracks[0]?.coverUrl ?? null,
      total: count(set.track_count) ?? tracks.length + unreadable,
      tracks,
      unreadable,
    };
  }
  const track = soundcloudTrack(sound, null);
  if (!track) return null;
  return { title: track.title, author: track.artists || null, coverUrl: track.coverUrl, total: 1, tracks: [track], unreadable: 0 };
}
