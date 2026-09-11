import { createHash, randomBytes } from "node:crypto";
import { env } from "../../config.js";
import { BoundedMap } from "../../utils/bounded-map.js";
import { mapSpotifyTrack, rememberTracks, spotifyConfigured, type MusicTrack } from "./spotify.js";

/**
 * The one-time "import my Spotify top tracks" (decision 2026-09-11).
 *
 * Authorization Code + PKCE, scope `user-top-read` and nothing else:
 *
 *   1. `startTopTracksImport(userId)` mints a `state` and a PKCE verifier,
 *      keeps both HERE, and returns Spotify's authorize URL. The app opens it
 *      in ASWebAuthenticationSession — which cannot attach our JWT to that
 *      page, and that is why step 1 is an authenticated POST returning a URL
 *      rather than a GET that redirects (a JWT in a query string ends up in
 *      access logs).
 *   2. Spotify sends the browser to our callback with `code` + `state`.
 *      `completeTopTracksImport` consumes the state (single use), exchanges the
 *      code, reads `/me/top/tracks` ONCE and forgets the token. Nothing about
 *      the Spotify account is stored: no access token, no refresh token, no
 *      Spotify user id.
 *   3. The callback bounces to `gennety://spotify-import?status=…`, which ends
 *      the web session; the app collects the candidates with
 *      `peekTopTracksImport` and the person picks up to three.
 *
 * State and candidates live in process memory, not a table: production is one
 * PM2 process, an attempt lives ten minutes, and a restart in between costs
 * the person one more tap — cheaper than a schema for data that must not
 * outlive the flow anyway. If the API ever runs as more than one process, this
 * is the thing to move first.
 *
 * The exchange is Spotify's documented PKCE one — client id + verifier, no
 * secret. Spotify documents that combination and not "secret AND verifier",
 * and the verifier never leaves this process, so the secret would add nothing.
 *
 * Expected to be switched off for almost everyone: a development-mode Spotify
 * app admits five allow-listed accounts and answers 403 to the rest, which is
 * what `not_allowed` is for.
 */

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const TOP_TRACKS_URL =
  "https://api.spotify.com/v1/me/top/tracks?limit=15&time_range=medium_term";
/** The only scope requested — reading the person's own top tracks. */
export const SPOTIFY_SCOPE = "user-top-read";
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const IMPORT_TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 5_000;
const LOG_PREFIX = "[spotify-oauth]";

/** What the callback tells the app, as `gennety://spotify-import?status=…`. */
export type ImportStatus =
  | "ok"
  /** The person pressed Cancel on Spotify's consent page. */
  | "cancelled"
  /** Spotify has no listening history for them yet. */
  | "empty"
  /** Their account is not on the development-mode allow-list (Spotify's 403). */
  | "not_allowed"
  /** Unknown, reused or stale `state` — start again. */
  | "expired"
  | "failed";

interface Attempt {
  userId: string;
  verifier: string;
  expiresAt: number;
}

interface PendingImport {
  tracks: MusicTrack[];
  expiresAt: number;
}

const attempts = new BoundedMap<string, Attempt>(1_000);
const imports = new BoundedMap<string, PendingImport>(1_000);

/** Test seam. */
export function __resetSpotifyOAuthState(): void {
  attempts.clear();
  imports.clear();
}

export function topTracksImportConfigured(): boolean {
  return spotifyConfigured() && Boolean(env.SPOTIFY_REDIRECT_URI);
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Step 1 — returns the Spotify authorize URL the app opens. */
export function startTopTracksImport(userId: string, now = Date.now()): string {
  const state = randomBytes(32).toString("base64url");
  // 64 random bytes → 86 base64url characters, inside PKCE's 43..128.
  const verifier = randomBytes(64).toString("base64url");
  attempts.set(state, { userId, verifier, expiresAt: now + ATTEMPT_TTL_MS });
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPE,
    state,
    code_challenge_method: "S256",
    code_challenge: pkceChallenge(verifier),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code: string, verifier: string): Promise<string | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: env.SPOTIFY_REDIRECT_URI,
        client_id: env.SPOTIFY_CLIENT_ID,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`${LOG_PREFIX} code exchange refused`, { status: response.status });
      return null;
    }
    // The body also carries a refresh token. It is deliberately dropped here:
    // the import is one-shot, and a token we never keep is one we cannot leak.
    const body = (await response.json()) as { access_token?: unknown };
    return typeof body.access_token === "string" ? body.access_token : null;
  } catch (err) {
    console.warn(`${LOG_PREFIX} code exchange threw`, { err: String(err) });
    return null;
  }
}

async function fetchTopTracks(accessToken: string): Promise<MusicTrack[] | "not_allowed" | null> {
  try {
    const response = await fetch(TOP_TRACKS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Development mode answers 403 to every account not on the allow-list —
    // the expected outcome for nearly everyone, so it is a status, not an error.
    if (response.status === 403) return "not_allowed";
    if (!response.ok) {
      console.warn(`${LOG_PREFIX} top tracks failed`, { status: response.status });
      return null;
    }
    const body = (await response.json()) as { items?: unknown };
    return Array.isArray(body.items)
      ? body.items.map(mapSpotifyTrack).filter((track): track is MusicTrack => track !== null)
      : [];
  } catch (err) {
    console.warn(`${LOG_PREFIX} top tracks threw`, { err: String(err) });
    return null;
  }
}

/** Step 2 — the callback. Never throws; every outcome is a status for the app. */
export async function completeTopTracksImport(
  query: { code?: unknown; state?: unknown; error?: unknown },
  now = Date.now(),
): Promise<ImportStatus> {
  const state = typeof query.state === "string" ? query.state : "";
  const attempt = state ? attempts.get(state) : undefined;
  // Single use whatever happens next: a replayed callback finds nothing.
  if (state) attempts.delete(state);
  if (!attempt || attempt.expiresAt < now) return "expired";

  if (typeof query.error === "string") {
    return query.error === "access_denied" ? "cancelled" : "failed";
  }
  const code = typeof query.code === "string" ? query.code : "";
  if (!code) return "failed";

  const accessToken = await exchangeCode(code, attempt.verifier);
  if (!accessToken) return "failed";

  const top = await fetchTopTracks(accessToken);
  if (top === null) return "failed";
  if (top === "not_allowed") return "not_allowed";
  if (top.length === 0) return "empty";

  rememberTracks(top, now);
  imports.set(attempt.userId, { tracks: top, expiresAt: now + IMPORT_TTL_MS });
  return "ok";
}

/** Step 3 — the candidates, for as long as the import is fresh. */
export function peekTopTracksImport(userId: string, now = Date.now()): MusicTrack[] | null {
  const entry = imports.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < now) {
    imports.delete(userId);
    return null;
  }
  return entry.tracks;
}

/** Called once the person saved: the import has done its job and does not linger. */
export function clearTopTracksImport(userId: string): void {
  imports.delete(userId);
}
