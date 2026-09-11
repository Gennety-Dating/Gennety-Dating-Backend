import { env } from "../../config.js";
import { BoundedMap } from "../../utils/bounded-map.js";

/**
 * Spotify Web API for music on the profile (decision 2026-09-11).
 *
 * Server-side only, and that is the point: the client secret lives in this
 * process, and the metadata a profile shows is what Spotify said about a track
 * id — never what a client claimed about it.
 *
 * Two kinds of token, and neither is ever persisted:
 *   - the APP token (Client Credentials) — search and single-track lookups,
 *     held in memory until shortly before it expires;
 *   - a USER token (Authorization Code + PKCE, `spotify-oauth.ts`) — lives for
 *     the one callback request that imports the top tracks, then is dropped.
 *
 * Written against development-mode limits (Spotify's 2026-02 changelog):
 * search `limit` ≤ 10, no batch `GET /tracks`, no `popularity`, and
 * `preview_url` null for every app registered after 2024-11-27.
 */

const ACCOUNTS_TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const TIMEOUT_MS = 5_000;
/** Re-mint the app token this long before Spotify says it expires. */
const TOKEN_EARLY_REFRESH_MS = 60_000;
/** Development mode caps search at 10 (it was 50 before 2026-02). */
export const SPOTIFY_SEARCH_LIMIT = 10;
/** Spotify offers 640 / 300 / 64 px covers; 300 is the smallest that stays sharp in a row. */
const PREFERRED_COVER_WIDTH = 300;
/** Identical queries inside this window are answered from memory. */
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * A track seen in a search or an import is remembered this long, so saving it
 * a minute later does not cost a second Spotify call. Only Spotify's own
 * answers go in here — never anything a client sent.
 */
const SEEN_TRACK_TTL_MS = 30 * 60 * 1000;

const LOG_PREFIX = "[spotify]";

/** The one shape every music surface speaks — API, table, match card. */
export interface MusicTrack {
  spotifyTrackId: string;
  title: string;
  /** Artist names joined with ", " in Spotify's order. */
  artists: string;
  albumName: string | null;
  coverUrl: string | null;
  /** Canonical `https://open.spotify.com/track/<id>` — built, not trusted. */
  spotifyUrl: string;
  previewUrl: string | null;
  explicit: boolean;
}

export type SpotifyError =
  /** SPOTIFY_CLIENT_ID / SECRET missing. */
  | "not_configured"
  /** Spotify unreachable, timed out, refused our token, or answered 5xx. */
  | "upstream_unavailable"
  /** Spotify's 429 — the app-wide quota, not this person's. */
  | "rate_limited"
  /** No such track, or Spotify no longer serves it. */
  | "not_found";

export type SpotifyResult<T> = { ok: true; value: T } | { ok: false; error: SpotifyError };

/** Spotify's base-62 track id. */
const TRACK_ID_RE = /^[0-9A-Za-z]{22}$/;

export function isSpotifyTrackId(value: unknown): value is string {
  return typeof value === "string" && TRACK_ID_RE.test(value);
}

export function spotifyConfigured(): boolean {
  return Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);
}

// --- Mapping -----------------------------------------------------------------

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** The smallest cover that is still at least the preferred width; failing that, the largest. */
function pickCover(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  let best: { url: string; width: number } | null = null;
  for (const image of images as Array<{ url?: unknown; width?: unknown } | null>) {
    if (typeof image?.url !== "string" || !isHttpsUrl(image.url)) continue;
    const width = typeof image.width === "number" ? image.width : 0;
    const bigEnough = width >= PREFERRED_COVER_WIDTH;
    const bestBigEnough = best !== null && best.width >= PREFERRED_COVER_WIDTH;
    if (
      best === null ||
      (bigEnough && (!bestBigEnough || width < best.width)) ||
      (!bigEnough && !bestBigEnough && width > best.width)
    ) {
      best = { url: image.url, width };
    }
  }
  return best?.url ?? null;
}

/** Spotify's track object → ours. Null for anything we would not want on a profile. */
export function mapSpotifyTrack(raw: unknown): MusicTrack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const track = raw as {
    id?: unknown;
    name?: unknown;
    artists?: unknown;
    album?: unknown;
    preview_url?: unknown;
    explicit?: unknown;
    is_local?: unknown;
  };
  // A local file has no catalogue id and nothing to link to.
  if (track.is_local === true) return null;
  if (!isSpotifyTrackId(track.id) || typeof track.name !== "string" || !track.name.trim()) {
    return null;
  }
  const artists = Array.isArray(track.artists)
    ? track.artists
        .map((artist) => {
          const name = (artist as { name?: unknown } | null)?.name;
          return typeof name === "string" ? name.trim() : "";
        })
        .filter((name) => name.length > 0)
    : [];
  if (artists.length === 0) return null;
  const album = (typeof track.album === "object" && track.album !== null ? track.album : {}) as {
    name?: unknown;
    images?: unknown;
  };
  return {
    spotifyTrackId: track.id,
    title: track.name.trim(),
    artists: artists.join(", "),
    albumName: typeof album.name === "string" && album.name.trim() ? album.name.trim() : null,
    coverUrl: pickCover(album.images),
    spotifyUrl: `https://open.spotify.com/track/${track.id}`,
    previewUrl:
      typeof track.preview_url === "string" && isHttpsUrl(track.preview_url)
        ? track.preview_url
        : null,
    explicit: track.explicit === true,
  };
}

// --- Caches ------------------------------------------------------------------

const searchCache = new BoundedMap<string, { tracks: MusicTrack[]; at: number }>(500);
const seenTracks = new BoundedMap<string, { track: MusicTrack; at: number }>(2_000);

/** Remember tracks Spotify just described, so a save right after needs no call. */
export function rememberTracks(tracks: readonly MusicTrack[], now = Date.now()): void {
  for (const track of tracks) seenTracks.set(track.spotifyTrackId, { track, at: now });
}

function recentlySeen(id: string, now = Date.now()): MusicTrack | null {
  const entry = seenTracks.get(id);
  if (!entry) return null;
  if (now - entry.at > SEEN_TRACK_TTL_MS) {
    seenTracks.delete(id);
    return null;
  }
  return entry.track;
}

// --- App token (Client Credentials) -------------------------------------------

interface AppToken {
  value: string;
  expiresAt: number;
}

let appToken: AppToken | null = null;
/** Single-flight: a burst of searches must not fan out into N token requests. */
let appTokenInFlight: Promise<AppToken | null> | null = null;

/** Test seam — forgets the token and every cache between cases. */
export function __resetSpotifyState(): void {
  appToken = null;
  appTokenInFlight = null;
  searchCache.clear();
  seenTracks.clear();
}

async function fetchAppToken(): Promise<AppToken | null> {
  const basic = Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString(
    "base64",
  );
  try {
    const response = await fetch(ACCOUNTS_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`${LOG_PREFIX} app token refused`, { status: response.status });
      return null;
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") return null;
    const lifetimeMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
    return {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, lifetimeMs - TOKEN_EARLY_REFRESH_MS),
    };
  } catch (err) {
    console.warn(`${LOG_PREFIX} app token fetch threw`, { err: String(err) });
    return null;
  }
}

async function getAppToken(forceRefresh: boolean): Promise<string | null> {
  if (!forceRefresh && appToken && Date.now() < appToken.expiresAt) return appToken.value;
  appTokenInFlight ??= fetchAppToken().finally(() => {
    appTokenInFlight = null;
  });
  const fresh = await appTokenInFlight;
  if (fresh) appToken = fresh;
  return fresh?.value ?? null;
}

type AppGetResult = { ok: true; body: unknown } | { ok: false; status: number | null };

/**
 * GET on the app token. A 401 means Spotify dropped the token early, so it is
 * re-minted once; `status: null` means we never got an answer at all.
 */
async function appGet(path: string): Promise<AppGetResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAppToken(attempt > 0);
    if (!token) return { ok: false, status: null };
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: null };
    }
    if (response.status === 401 && attempt === 0) {
      appToken = null;
      continue;
    }
    if (!response.ok) return { ok: false, status: response.status };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, status: null };
    }
  }
  return { ok: false, status: 401 };
}

function failureFor(status: number | null): SpotifyError {
  return status === 429 ? "rate_limited" : "upstream_unavailable";
}

// --- Public operations --------------------------------------------------------

/**
 * Catalogue search. The query is never logged — it is something a person
 * typed, and it says more about them than the result does.
 */
export async function searchTracks(
  query: string,
  now = Date.now(),
): Promise<SpotifyResult<MusicTrack[]>> {
  if (!spotifyConfigured()) return { ok: false, error: "not_configured" };
  const key = query.trim().toLowerCase();
  const cached = searchCache.get(key);
  if (cached && now - cached.at <= SEARCH_CACHE_TTL_MS) return { ok: true, value: cached.tracks };

  const params = new URLSearchParams({
    q: query.trim(),
    type: "track",
    limit: String(SPOTIFY_SEARCH_LIMIT),
  });
  const result = await appGet(`/search?${params.toString()}`);
  if (!result.ok) {
    console.warn(`${LOG_PREFIX} search failed`, { status: result.status });
    return { ok: false, error: failureFor(result.status) };
  }
  const items = (result.body as { tracks?: { items?: unknown } } | null)?.tracks?.items;
  const tracks = Array.isArray(items)
    ? items.map(mapSpotifyTrack).filter((track): track is MusicTrack => track !== null)
    : [];
  searchCache.set(key, { tracks, at: now });
  rememberTracks(tracks, now);
  return { ok: true, value: tracks };
}

/**
 * One track by id — the only way a track reaches a profile. `fresh` skips the
 * recently-seen memory; the nightly refresh needs Spotify's current answer.
 */
export async function getTrack(
  id: string,
  options: { fresh?: boolean } = {},
): Promise<SpotifyResult<MusicTrack>> {
  if (!spotifyConfigured()) return { ok: false, error: "not_configured" };
  if (!isSpotifyTrackId(id)) return { ok: false, error: "not_found" };
  if (!options.fresh) {
    const seen = recentlySeen(id);
    if (seen) return { ok: true, value: seen };
  }
  const result = await appGet(`/tracks/${id}`);
  if (!result.ok) {
    // 400 is Spotify's answer to a well-formed id it has never issued.
    if (result.status === 404 || result.status === 400) return { ok: false, error: "not_found" };
    console.warn(`${LOG_PREFIX} track lookup failed`, { status: result.status });
    return { ok: false, error: failureFor(result.status) };
  }
  const track = mapSpotifyTrack(result.body);
  if (!track) return { ok: false, error: "not_found" };
  rememberTracks([track]);
  return { ok: true, value: track };
}
