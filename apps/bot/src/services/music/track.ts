/**
 * The one shape every music surface speaks — API, table, match card — whatever
 * the track's provider (decision 2026-10-08: Apple Music is the main source,
 * Spotify stays as catalogue search; a profile may mix them).
 */

export const MUSIC_PROVIDERS = ["spotify", "apple_music"] as const;
export type MusicProvider = (typeof MUSIC_PROVIDERS)[number];

export function isMusicProvider(value: unknown): value is MusicProvider {
  return typeof value === "string" && (MUSIC_PROVIDERS as readonly string[]).includes(value);
}

export interface MusicTrack {
  provider: MusicProvider;
  /** The provider's own id — Spotify's base-62 track id or Apple Music's catalogue song id. */
  trackId: string;
  title: string;
  /** Artist names joined with ", " in the provider's order. */
  artists: string;
  albumName: string | null;
  coverUrl: string | null;
  /** The link back to the provider: built or read from its answer, never a client's string. */
  url: string;
  previewUrl: string | null;
  explicit: boolean;
  /**
   * Apple Music storefront the song was read from; null for Spotify. Sent back
   * so a client can re-save the set (removing one track re-sends the rest)
   * without asking MusicKit again.
   */
  storefront: string | null;
}

/**
 * A track as it goes over the wire: the provider-neutral shape plus the two
 * names it had before 2026-10-08. Builds from before the Apple Music switch
 * decode `spotifyTrackId` and `spotifyUrl` as required fields, so a response
 * without them fails to decode and the whole music section disappears (audit
 * K-01). Additive only — new clients read `trackId`/`url` and ignore these.
 */
export interface WireMusicTrack extends MusicTrack {
  /** @deprecated Same value as `trackId`; kept for pre-2026-10-08 builds. */
  spotifyTrackId: string;
  /** @deprecated Same value as `url`; kept for pre-2026-10-08 builds. */
  spotifyUrl: string;
}

export function withLegacyMusicFields(track: MusicTrack): WireMusicTrack {
  return { ...track, spotifyTrackId: track.trackId, spotifyUrl: track.url };
}

/** What the table keeps beyond what is shown. */
export interface StoredMusicTrack extends MusicTrack {
  isrc: string | null;
}

export type MusicError =
  /** The provider's keys are missing on this server. */
  | "not_configured"
  /** The provider was unreachable, timed out, refused our token, or answered 5xx. */
  | "upstream_unavailable"
  /** The provider's 429 — the app-wide quota, not this person's. */
  | "rate_limited"
  /** No such track, or the provider no longer serves it. */
  | "not_found";

export type MusicResult<T> = { ok: true; value: T } | { ok: false; error: MusicError };

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
