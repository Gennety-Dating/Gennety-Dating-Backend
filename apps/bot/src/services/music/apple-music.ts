import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { env } from "../../config.js";
import { BoundedMap } from "../../utils/bounded-map.js";
import { isHttpsUrl, type MusicResult, type StoredMusicTrack } from "./track.js";

/**
 * Apple Music API for music on the profile (decision 2026-10-08).
 *
 * The person's own listening is read ON THE IPHONE through MusicKit — that is
 * the "my music in one tap" path, and it needs no server call at all. What
 * reaches us is catalogue song ids, and this module turns each into Apple's own
 * metadata, so what a partner reads is Apple's answer for that id and never a
 * title or a cover the client chose (the same rule as Spotify).
 *
 * Auth is a developer token: an ES256 JWT signed with a MusicKit private key
 * (.p8, developer.apple.com → Keys, "Media Services"). Minted here, cached in
 * memory, never persisted and never handed to a client — the iPhone gets its
 * own token from the system.
 *
 * Catalogue availability is per country, so every lookup names a storefront
 * (`ua`, `us`, …) — the one the person's account reported on the device.
 */

const API_BASE = "https://api.music.apple.com/v1";
const TIMEOUT_MS = 5_000;
/**
 * Apple accepts developer tokens up to six months old; ours lives a day and is
 * re-minted an hour before that, so a rotated key takes effect within a day.
 */
const TOKEN_LIFETIME_S = 24 * 60 * 60;
const TOKEN_EARLY_REFRESH_MS = 60 * 60 * 1000;
/** Square cover side asked of Apple's artwork template — the size Spotify's sits at. */
const COVER_SIDE = 300;
/** A song read for a save is remembered this long, so the save a minute later costs nothing. */
const SEEN_SONG_TTL_MS = 30 * 60 * 1000;

const LOG_PREFIX = "[apple-music]";

/** Apple Music catalogue song ids are numeric. A library id (`i.…`) has no catalogue page. */
const SONG_ID_RE = /^[0-9]{1,20}$/;
/** Storefronts are ISO 3166-1 alpha-2, lower case. */
const STOREFRONT_RE = /^[a-z]{2}$/;

export function isAppleMusicSongId(value: unknown): value is string {
  return typeof value === "string" && SONG_ID_RE.test(value);
}

export function isStorefront(value: unknown): value is string {
  return typeof value === "string" && STOREFRONT_RE.test(value);
}

export function appleMusicConfigured(): boolean {
  return Boolean(env.APPLE_MUSIC_KEY_PATH && env.APPLE_MUSIC_KEY_ID && env.APPLE_MUSIC_TEAM_ID);
}

// --- Developer token ----------------------------------------------------------

let privateKey: string | null = null;
let developerToken: { value: string; expiresAt: number } | null = null;

function signingKey(): string {
  privateKey ??= readFileSync(env.APPLE_MUSIC_KEY_PATH, "utf8");
  return privateKey;
}

/** Mint (or reuse) the developer token. Null when the key cannot be read. */
export function appleMusicDeveloperToken(now = Date.now()): string | null {
  if (developerToken && now < developerToken.expiresAt) return developerToken.value;
  try {
    const value = jwt.sign({}, signingKey(), {
      algorithm: "ES256",
      issuer: env.APPLE_MUSIC_TEAM_ID,
      keyid: env.APPLE_MUSIC_KEY_ID,
      expiresIn: TOKEN_LIFETIME_S,
    });
    developerToken = {
      value,
      expiresAt: now + TOKEN_LIFETIME_S * 1000 - TOKEN_EARLY_REFRESH_MS,
    };
    return value;
  } catch (err) {
    console.warn(`${LOG_PREFIX} developer token could not be minted`, { err: String(err) });
    return null;
  }
}

// --- Mapping ------------------------------------------------------------------

/** Apple's `{w}x{h}` artwork template → a concrete https URL, or null. */
function coverFrom(artwork: unknown): string | null {
  const template = (artwork as { url?: unknown } | null)?.url;
  if (typeof template !== "string") return null;
  const url = template.replace("{w}", String(COVER_SIDE)).replace("{h}", String(COVER_SIDE));
  return isHttpsUrl(url) ? url : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Apple's song resource → ours. Null for anything we would not want on a profile. */
export function mapAppleMusicSong(raw: unknown, storefront: string): StoredMusicTrack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const song = raw as { id?: unknown; type?: unknown; attributes?: unknown };
  if (song.type !== "songs" || !isAppleMusicSongId(song.id)) return null;
  const attributes = (typeof song.attributes === "object" && song.attributes !== null
    ? song.attributes
    : {}) as {
    name?: unknown;
    artistName?: unknown;
    albumName?: unknown;
    artwork?: unknown;
    url?: unknown;
    isrc?: unknown;
    contentRating?: unknown;
    previews?: unknown;
  };
  const title = nonEmpty(attributes.name);
  const artists = nonEmpty(attributes.artistName);
  const url = nonEmpty(attributes.url);
  // No link back to Apple Music — nothing to send the partner to.
  if (!title || !artists || !url || !isHttpsUrl(url)) return null;
  const preview = Array.isArray(attributes.previews)
    ? (attributes.previews[0] as { url?: unknown } | undefined)?.url
    : undefined;
  return {
    provider: "apple_music",
    trackId: song.id,
    title,
    artists,
    albumName: nonEmpty(attributes.albumName),
    coverUrl: coverFrom(attributes.artwork),
    url,
    previewUrl: typeof preview === "string" && isHttpsUrl(preview) ? preview : null,
    explicit: attributes.contentRating === "explicit",
    storefront,
    isrc: nonEmpty(attributes.isrc),
  };
}

// --- Cache --------------------------------------------------------------------

const seenSongs = new BoundedMap<string, { song: StoredMusicTrack; at: number }>(2_000);

/** Test seam — forgets the key, the token and the cache between cases. */
export function __resetAppleMusicState(): void {
  privateKey = null;
  developerToken = null;
  seenSongs.clear();
}

// --- Public operation -----------------------------------------------------------

/**
 * One catalogue song by id in one storefront — the only way an Apple Music
 * track reaches a profile. `fresh` skips the memory; the nightly refresh needs
 * Apple's current answer.
 */
export async function getAppleMusicSong(
  id: string,
  storefront: string,
  options: { fresh?: boolean } = {},
): Promise<MusicResult<StoredMusicTrack>> {
  if (!appleMusicConfigured()) return { ok: false, error: "not_configured" };
  if (!isAppleMusicSongId(id) || !isStorefront(storefront)) return { ok: false, error: "not_found" };

  const key = `${storefront}:${id}`;
  if (!options.fresh) {
    const seen = seenSongs.get(key);
    if (seen && Date.now() - seen.at <= SEEN_SONG_TTL_MS) return { ok: true, value: seen.song };
  }

  const token = appleMusicDeveloperToken();
  if (!token) return { ok: false, error: "not_configured" };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/catalog/${storefront}/songs/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "upstream_unavailable" };
  }
  if (response.status === 404) return { ok: false, error: "not_found" };
  if (!response.ok) {
    console.warn(`${LOG_PREFIX} song lookup failed`, { status: response.status });
    if (response.status === 401 || response.status === 403) developerToken = null;
    return { ok: false, error: response.status === 429 ? "rate_limited" : "upstream_unavailable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "upstream_unavailable" };
  }
  const data = (body as { data?: unknown } | null)?.data;
  const song = Array.isArray(data) ? mapAppleMusicSong(data[0], storefront) : null;
  if (!song) return { ok: false, error: "not_found" };
  seenSongs.set(key, { song, at: Date.now() });
  return { ok: true, value: song };
}
