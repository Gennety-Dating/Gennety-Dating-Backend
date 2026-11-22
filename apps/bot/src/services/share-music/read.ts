import {
  SHARE_MUSIC_CACHE_TTL_MS,
  SHARE_MUSIC_LOOKUP_CONCURRENCY,
  SHARE_MUSIC_MAX_TRACKS,
  SHARE_MUSIC_READ_BUDGET_MS,
} from "@gennety/shared";
import { env } from "../../config.js";
import { BoundedMap } from "../../utils/bounded-map.js";
import {
  appleMusicConfigured,
  getAppleMusicCollection,
  getAppleMusicSong,
  type AppleMusicCollection,
} from "../music/apple-music.js";
import { MAX_PROFILE_TRACKS, profileMusicKeys, type ProfileMusicKeys } from "../music/profile-music.js";
import { getTrack, searchTracks } from "../music/spotify.js";
import {
  musicTitleKey,
  type MusicProvider,
  type MusicResult,
  type MusicTrack,
  type StoredMusicTrack,
} from "../music/track.js";
import { fetchAllowlistedPage } from "../short-video/safe-fetch.js";
import {
  classifyShareMusicUrl,
  isShareMusicHost,
  type ShareMusicKind,
  type ShareMusicRef,
  type ShareMusicSource,
} from "./links.js";
import { matchQuery, pickMatch } from "./match.js";
import {
  findYouTubeAlbumPlaylist,
  parseMusicLdJson,
  parseSoundCloud,
  parseSpotifyEmbed,
  parseYandexMusic,
  parseYouTubeOembed,
  parseYouTubePlaylist,
  type SourcePage,
  type SourceTrack,
} from "./parse.js";

/**
 * «Поделиться → Gennety» for a playlist, an album or a track (decision
 * 2026-11-22): the share sheet shows every track as a card, all ticked, and
 * «Добавить N» pins them to the profile's music in one tap
 * (`appendProfileMusic`).
 *
 * The read takes only what a logged-out browser is served — Spotify's embed
 * player data, YouTube's playlist page and oEmbed, SoundCloud's page data,
 * Yandex Music's public JSON, an Apple Music page's schema.org block — or,
 * for Apple Music when its key is configured, the catalogue API the profile
 * already uses. No new key and no model: nothing here is ever sent to one.
 *
 * A profile keeps only Spotify and Apple Music ids (their metadata is
 * re-read weekly), so a track from YouTube, Yandex or SoundCloud is looked up
 * in Spotify's catalogue and shown as what will be pinned; no confident hit
 * means the card stays, unticked, as `not_found`.
 *
 * Never throws. A provider that gives nothing is `closed`; a read that ran out
 * of time or quota midway is `partial`, with what it had.
 */

export type ShareMusicTrackState = "new" | "added" | "not_found";

/** What «Добавить» sends back for one card — the ref `appendProfileMusic` takes. */
export interface ShareMusicMatch {
  provider: MusicProvider;
  trackId: string;
  /** Apple Music only; null for Spotify. */
  storefront: string | null;
  /** The track on that provider — what the profile will link to. */
  url: string;
}

export interface ShareMusicTrack {
  /** Stable within one read: its position in the list. */
  key: string;
  title: string;
  artists: string;
  albumName: string | null;
  coverUrl: string | null;
  /** The track on the shared source, when it has its own page. */
  sourceUrl: string | null;
  match: ShareMusicMatch | null;
  state: ShareMusicTrackState;
  /** Ticked by default: every `new` track while the profile has room. */
  selected: boolean;
}

export interface ShareMusic {
  status: "read" | "closed";
  source: ShareMusicSource;
  kind: ShareMusicKind;
  url: string;
  title: string | null;
  author: string | null;
  coverUrl: string | null;
  /** Tracks the provider says the list has; null when it did not say. */
  total: number | null;
  /** The list is longer than what is shown (the cap, or the provider's first page). */
  truncated: boolean;
  /** Some lookups did not finish (time, quota) or some rows were unreadable; a retry may show more. */
  partial: boolean;
  /** Free places in the profile's music. */
  slotsLeft: number;
  /** How many cards are ticked — the N of «Добавить N». */
  selectedCount: number;
  tracks: ShareMusicTrack[];
}

export type ShareMusicReadOutcome = { ok: true; music: ShareMusic } | { ok: false; error: "not_music" };

export interface FetchTextOptions {
  timeoutMs: number;
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface ShareMusicReadDeps {
  /** A page or JSON body from an allowlisted music host, or null. */
  fetchText?: (url: string, options: FetchTextOptions) => Promise<{ body: string; finalUrl: string } | null>;
  appleConfigured?: () => boolean;
  appleCollection?: (
    kind: "playlists" | "albums",
    id: string,
    storefront: string,
  ) => Promise<MusicResult<AppleMusicCollection>>;
  appleSong?: (id: string, storefront: string) => Promise<MusicResult<StoredMusicTrack>>;
  spotifyTrack?: (id: string) => Promise<MusicResult<MusicTrack>>;
  search?: (query: string) => Promise<MusicResult<MusicTrack[]>>;
  keys?: (userId: string) => Promise<ProfileMusicKeys>;
  now?: () => number;
}

/** youtube.com pages are megabytes of script; the list sits early but not first. */
const YOUTUBE_PAGE_MAX_BYTES = 4_000_000;
/**
 * The «reject all» consent answer, so a server in the EU gets the playlist
 * page rather than consent.youtube.com. A consent choice, not a login: it
 * identifies nobody.
 */
const YOUTUBE_HEADERS = { Cookie: "SOCS=CAI", "Accept-Language": "en-US,en;q=0.9" };
const LOG_PREFIX = "[share-music]";

/* ── reading the source ─────────────────────────────────────────────────── */

/** A source row plus, when known, the catalogue's own answer for it. */
interface Row {
  source: SourceTrack;
  catalogue: (MusicTrack & { storefront: string | null }) | null;
}

interface SourceRead {
  ref: ShareMusicRef;
  page: SourcePage;
  rows: Row[];
  /** The provider's list goes on past this page. */
  more: boolean;
}

interface Context {
  deps: Required<Omit<ShareMusicReadDeps, "keys">>;
  deadline: number;
}

function remaining(ctx: Context): number {
  return ctx.deadline - ctx.deps.now();
}

async function text(ctx: Context, url: string, extra: Omit<FetchTextOptions, "timeoutMs"> = {}): Promise<string | null> {
  const timeoutMs = Math.min(env.SHORT_VIDEO_FETCH_TIMEOUT_MS, remaining(ctx));
  if (timeoutMs <= 0) return null;
  return (await ctx.deps.fetchText(url, { timeoutMs, ...extra }))?.body ?? null;
}

function fromCatalogue(track: MusicTrack | StoredMusicTrack): Row {
  return {
    source: {
      title: track.title,
      artists: track.artists,
      albumName: track.albumName,
      coverUrl: track.coverUrl,
      sourceUrl: track.url,
      ref:
        track.provider === "apple_music" && track.storefront
          ? { provider: "apple_music", trackId: track.trackId, storefront: track.storefront }
          : { provider: "spotify", trackId: track.trackId },
    },
    catalogue: { ...track, storefront: track.storefront ?? null },
  };
}

function plain(page: SourcePage): Row[] {
  return page.tracks.map((source) => ({ source, catalogue: null }));
}

/** A short-link stub → the ref it lands on (Spotify's Branch links, SoundCloud's `on.`). */
async function resolveStub(ctx: Context, ref: ShareMusicRef): Promise<ShareMusicRef | null> {
  const timeoutMs = Math.min(env.SHORT_VIDEO_FETCH_TIMEOUT_MS, remaining(ctx));
  const hop = timeoutMs > 0 ? await ctx.deps.fetchText(ref.url, { timeoutMs }) : null;
  if (!hop) return null;
  const landed = classifyShareMusicUrl(hop.finalUrl);
  if (landed?.id) return landed;
  // Some short links answer 200 with the target in the page instead of a redirect.
  const inBody = /https:\/\/(?:open\.spotify\.com\/(?:playlist|album|track)\/[0-9A-Za-z]{22}|soundcloud\.com\/[A-Za-z0-9_-]+\/(?:sets\/)?[A-Za-z0-9_-]+)/u.exec(
    hop.body,
  )?.[0];
  const fromBody = inBody ? classifyShareMusicUrl(inBody) : null;
  return fromBody?.id ? fromBody : null;
}

async function readYouTubeList(ctx: Context, list: string): Promise<SourcePage | null> {
  const body = await text(ctx, `https://www.youtube.com/playlist?list=${list}`, {
    maxBytes: YOUTUBE_PAGE_MAX_BYTES,
    headers: YOUTUBE_HEADERS,
  });
  return body ? parseYouTubePlaylist(body) : null;
}

async function readSource(ctx: Context, ref: ShareMusicRef): Promise<SourceRead | null> {
  const id = ref.id!;
  const done = (page: SourcePage | null, rows?: Row[], more = false): SourceRead | null =>
    page ? { ref, page, rows: rows ?? plain(page), more } : null;

  switch (ref.source) {
    case "spotify": {
      if (ref.kind === "track") {
        const found = await ctx.deps.spotifyTrack(id);
        if (found.ok) {
          const row = fromCatalogue(found.value);
          return done({ title: found.value.title, author: found.value.artists, coverUrl: found.value.coverUrl, total: 1, tracks: [row.source], unreadable: 0 }, [row]);
        }
      }
      const body = await text(ctx, `https://open.spotify.com/embed/${ref.kind}/${id}`);
      return done(body ? parseSpotifyEmbed(body) : null);
    }
    case "youtube":
    case "youtube_music": {
      if (ref.kind === "track") {
        const body = await text(ctx, `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
        return done(body ? parseYouTubeOembed(body, id) : null);
      }
      let list = id;
      if (id.startsWith("MPREb_")) {
        const body = await text(ctx, `https://music.youtube.com/browse/${id}`, {
          maxBytes: YOUTUBE_PAGE_MAX_BYTES,
          headers: YOUTUBE_HEADERS,
        });
        const found = body ? findYouTubeAlbumPlaylist(body) : null;
        if (!found) return null;
        list = found;
      }
      const page = await readYouTubeList(ctx, list);
      // The first page of a YouTube list holds about 100 rows.
      return done(page, undefined, Boolean(page && page.total !== null && page.total > page.tracks.length + page.unreadable));
    }
    case "apple_music": {
      const storefront = ref.storefront!;
      if (ctx.deps.appleConfigured()) {
        if (ref.kind === "track") {
          const song = await ctx.deps.appleSong(id, storefront);
          if (song.ok) {
            const row = fromCatalogue(song.value);
            return done({ title: song.value.title, author: song.value.artists, coverUrl: song.value.coverUrl, total: 1, tracks: [row.source], unreadable: 0 }, [row]);
          }
        } else {
          const read = await ctx.deps.appleCollection(ref.kind === "album" ? "albums" : "playlists", id, storefront);
          if (read.ok) {
            const rows = read.value.songs.map(fromCatalogue);
            return done(
              { title: read.value.name, author: read.value.author, coverUrl: read.value.coverUrl, total: read.value.total, tracks: rows.map((row) => row.source), unreadable: read.value.skipped },
              rows,
              read.value.more,
            );
          }
        }
      }
      // No key (or Apple said no): the page's own schema.org block, matched like any other source.
      const body = await text(ctx, ref.url);
      return done(body ? parseMusicLdJson(body) : null);
    }
    case "yandex_music": {
      const api =
        ref.kind === "album"
          ? `https://api.music.yandex.net/albums/${id}/with-tracks`
          : ref.kind === "track"
            ? `https://api.music.yandex.net/tracks/${id}`
            : ref.owner
              ? `https://api.music.yandex.net/users/${encodeURIComponent(ref.owner)}/playlists/${id}`
              : `https://api.music.yandex.net/playlist/${id}`;
      const body = await text(ctx, api);
      const page = body ? parseYandexMusic(body) : null;
      if (page) return done(page);
      const html = await text(ctx, ref.url);
      return done(html ? parseMusicLdJson(html) : null);
    }
    case "soundcloud": {
      const body = await text(ctx, ref.url);
      return done(body ? parseSoundCloud(body) : null);
    }
  }
}

/* ── matching each row to a catalogue the profile keeps ─────────────────── */

interface BaseTrack {
  title: string;
  artists: string;
  albumName: string | null;
  coverUrl: string | null;
  sourceUrl: string | null;
  match: ShareMusicMatch | null;
}

interface BaseRead {
  status: "read" | "closed";
  source: ShareMusicSource;
  kind: ShareMusicKind;
  url: string;
  title: string | null;
  author: string | null;
  coverUrl: string | null;
  total: number | null;
  truncated: boolean;
  partial: boolean;
  tracks: BaseTrack[];
}

function matchOf(track: MusicTrack & { storefront: string | null }): ShareMusicMatch {
  return { provider: track.provider, trackId: track.trackId, storefront: track.provider === "apple_music" ? track.storefront : null, url: track.url };
}

/** The card shows what will be pinned: the catalogue's own words when known. */
function shown(row: Row, catalogue: (MusicTrack & { storefront: string | null }) | null): BaseTrack {
  if (catalogue) {
    return {
      title: catalogue.title,
      artists: catalogue.artists,
      albumName: catalogue.albumName,
      coverUrl: catalogue.coverUrl ?? row.source.coverUrl,
      sourceUrl: row.source.sourceUrl,
      match: matchOf(catalogue),
    };
  }
  const ref = row.source.ref;
  return {
    ...row.source,
    match: ref
      ? {
          provider: ref.provider,
          trackId: ref.trackId,
          storefront: ref.provider === "apple_music" ? ref.storefront : null,
          url:
            row.source.sourceUrl ??
            (ref.provider === "spotify"
              ? `https://open.spotify.com/track/${ref.trackId}`
              : `https://music.apple.com/${ref.storefront}/song/${ref.trackId}`),
        }
      : null,
  };
}

/** One row's lookup: a cover for a bare Spotify id, a Spotify search for the rest. */
async function lookUp(ctx: Context, row: Row, stop: { quota: boolean }): Promise<{ track: BaseTrack; finished: boolean }> {
  if (row.catalogue) return { track: shown(row, row.catalogue), finished: true };
  const ref = row.source.ref;
  if (ref?.provider === "apple_music") return { track: shown(row, null), finished: true };
  if (ref?.provider === "spotify") {
    // Already a Spotify id; the call only brings the cover (an embed row has
    // none) and warms the cache «Добавить» reads from. Missing it costs a cover.
    if (row.source.coverUrl || stop.quota || remaining(ctx) <= 0) return { track: shown(row, null), finished: true };
    const found = await ctx.deps.spotifyTrack(ref.trackId);
    if (!found.ok && found.error === "rate_limited") stop.quota = true;
    return { track: shown(row, found.ok ? { ...found.value, storefront: null } : null), finished: true };
  }
  // No artist to vouch for a hit (see `pickMatch`): a search could only guess.
  if (!row.source.artists) return { track: shown(row, null), finished: true };
  if (stop.quota || remaining(ctx) <= 0) return { track: shown(row, null), finished: false };
  const results = await ctx.deps.search(matchQuery(row.source.title, row.source.artists));
  if (!results.ok) {
    if (results.error === "rate_limited" || results.error === "not_configured") stop.quota = true;
    return { track: shown(row, null), finished: false };
  }
  const hit = pickMatch(row.source.title, row.source.artists, results.value);
  return { track: shown(row, hit ? { ...hit, storefront: null } : null), finished: true };
}

async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]!);
      }
    }),
  );
  return results;
}

function closed(ref: ShareMusicRef): BaseRead {
  return {
    status: "closed",
    source: ref.source,
    kind: ref.kind,
    url: ref.url,
    title: null,
    author: null,
    coverUrl: null,
    total: null,
    truncated: false,
    partial: false,
    tracks: [],
  };
}

async function buildRead(ctx: Context, ref: ShareMusicRef): Promise<{ read: BaseRead; complete: boolean }> {
  const source = await readSource(ctx, ref);
  if (!source || source.rows.length === 0) return { read: closed(ref), complete: false };

  // One card per song: a playlist that lists a song twice shows it once.
  const seen = new Set<string>();
  const unique = source.rows.filter((row) => {
    const key = musicTitleKey(row.source.title, row.source.artists);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rows = unique.slice(0, SHARE_MUSIC_MAX_TRACKS);

  const stop = { quota: false };
  const looked = await pool(rows, SHARE_MUSIC_LOOKUP_CONCURRENCY, (row) => lookUp(ctx, row, stop));
  // Two rows can land on one catalogue track (an upload and its lyric video).
  const matched = new Set<string>();
  const tracks = looked
    .map(({ track }) => track)
    .filter((track) => {
      if (!track.match) return true;
      const key = `${track.match.provider}:${track.match.trackId}`;
      if (matched.has(key)) return false;
      matched.add(key);
      return true;
    });
  const finished = looked.every((entry) => entry.finished);
  const page = source.page;
  return {
    read: {
      status: "read",
      source: source.ref.source,
      kind: source.ref.kind,
      url: source.ref.url,
      title: page.title,
      author: page.author,
      coverUrl: page.coverUrl ?? tracks[0]?.coverUrl ?? null,
      total: page.total,
      truncated: source.more || unique.length > rows.length,
      partial: !finished || page.unreadable > 0,
      tracks,
    },
    complete: finished,
  };
}

/* ── the per-person view and the cache ──────────────────────────────────── */

const cache = new BoundedMap<string, { read: BaseRead; at: number }>(300);

/** Test seam. */
export function clearShareMusicCache(): void {
  cache.clear();
}

/** «Already on your profile» and the default ticks — per person, never cached. */
export function forViewer(read: BaseRead, keys: ProfileMusicKeys): ShareMusic {
  const slotsLeft = Math.max(0, MAX_PROFILE_TRACKS - keys.count);
  let selectedCount = 0;
  const tracks = read.tracks.map((track, index): ShareMusicTrack => {
    const already =
      (track.match !== null && keys.refs.has(`${track.match.provider}:${track.match.trackId}`)) ||
      keys.titles.has(musicTitleKey(track.title, track.artists));
    const state: ShareMusicTrackState = already ? "added" : track.match ? "new" : "not_found";
    const selected = state === "new" && selectedCount < slotsLeft;
    if (selected) selectedCount += 1;
    return { key: String(index), ...track, state, selected };
  });
  return { ...read, slotsLeft, selectedCount, tracks };
}

function defaultFetchText(url: string, options: FetchTextOptions) {
  return fetchAllowlistedPage(url, isShareMusicHost, options).then((page) =>
    page.ok ? { body: page.body, finalUrl: page.finalUrl } : null,
  );
}

/** A shared URL → the share sheet's music view for this person. */
export async function readSharedMusic(
  url: string,
  userId: string,
  deps: ShareMusicReadDeps = {},
): Promise<ShareMusicReadOutcome> {
  let ref = classifyShareMusicUrl(url);
  if (!ref) return { ok: false, error: "not_music" };

  const ctx: Context = {
    deps: {
      fetchText: deps.fetchText ?? defaultFetchText,
      appleConfigured: deps.appleConfigured ?? appleMusicConfigured,
      appleCollection: deps.appleCollection ?? getAppleMusicCollection,
      appleSong: deps.appleSong ?? ((id, storefront) => getAppleMusicSong(id, storefront)),
      spotifyTrack: deps.spotifyTrack ?? ((id) => getTrack(id)),
      search: deps.search ?? ((query) => searchTracks(query)),
      now: deps.now ?? Date.now,
    },
    deadline: 0,
  };
  const now = ctx.deps.now();
  ctx.deadline = now + SHARE_MUSIC_READ_BUDGET_MS;

  const stubUrl = ref.id ? null : ref.url;
  const hit = cache.get(ref.url);
  let read: BaseRead;
  if (hit && now - hit.at <= SHARE_MUSIC_CACHE_TTL_MS) {
    read = hit.read;
  } else {
    if (!ref.id) {
      const landed = await resolveStub(ctx, ref);
      ref = landed ?? ref;
    }
    const again = ref.id ? cache.get(ref.url) : undefined;
    if (again && now - again.at <= SHARE_MUSIC_CACHE_TTL_MS) {
      read = again.read;
    } else if (!ref.id) {
      read = closed(ref);
    } else {
      const built = await buildRead(ctx, ref);
      read = built.read;
      // Only a read that finished is worth reusing; a partial one is retried.
      if (built.complete) {
        cache.set(ref.url, { read, at: now });
        if (stubUrl) cache.set(stubUrl, { read, at: now });
      }
      console.info(`${LOG_PREFIX} read`, {
        source: read.source,
        kind: read.kind,
        status: read.status,
        tracks: read.tracks.length,
        matched: read.tracks.filter((track) => track.match).length,
        partial: read.partial,
      });
    }
  }
  return { ok: true, music: forViewer(read, await (deps.keys ?? profileMusicKeys)(userId)) };
}
