import { prisma } from "@gennety/db";
import { getAppleMusicSong, isAppleMusicSongId, isStorefront } from "./apple-music.js";
import { getTrack, isSpotifyTrackId } from "./spotify.js";
import { clearTopTracksImport } from "./spotify-oauth.js";
import {
  isMusicProvider,
  type MusicError,
  type MusicProvider,
  type MusicResult,
  type MusicTrack,
  type StoredMusicTrack,
} from "./track.js";

/**
 * The tracks pinned to a profile (decisions 2026-09-11, 2026-10-08).
 * Display-only — read the `ProfileMusicTrack` model comment before adding a
 * reader anywhere else.
 */

/** The product rule: a profile shows at most three tracks. */
export const MAX_PROFILE_TRACKS = 3;

/** A week, then the provider is asked again (Spotify's Terms: shown data must be current). */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows looked at per nightly run; the rest wait for the next night. */
const REFRESH_BATCH = 200;

/** The columns every reader selects — one list, so a new field lands everywhere. */
export const MUSIC_TRACK_SELECT = {
  provider: true,
  trackId: true,
  title: true,
  artists: true,
  albumName: true,
  coverUrl: true,
  trackUrl: true,
  previewUrl: true,
  explicit: true,
} as const;

type MusicTrackRow = {
  provider: string;
  trackId: string;
  title: string;
  artists: string;
  albumName: string | null;
  coverUrl: string | null;
  trackUrl: string;
  previewUrl: string | null;
  explicit: boolean;
};

export function serializeMusicTrack(row: MusicTrackRow): MusicTrack {
  return {
    // Only this module writes the column, so anything else is a row from
    // before providers existed — and every one of those is Spotify's.
    provider: isMusicProvider(row.provider) ? row.provider : "spotify",
    trackId: row.trackId,
    title: row.title,
    artists: row.artists,
    albumName: row.albumName,
    coverUrl: row.coverUrl,
    url: row.trackUrl,
    previewUrl: row.previewUrl,
    explicit: row.explicit,
  };
}

export async function listProfileMusic(userId: string): Promise<MusicTrack[]> {
  const rows = await prisma.profileMusicTrack.findMany({
    where: { userId },
    orderBy: { position: "asc" },
    select: MUSIC_TRACK_SELECT,
  });
  return rows.map(serializeMusicTrack);
}

/**
 * How many tracks the person pinned — a number and nothing else, for the
 * profile-gaps read (`services/profile-gaps.ts`, decision 2026-10-01), which
 * only needs "is the music section still empty". It lives HERE, inside the
 * allow-listed reader, so that read never selects a track: no title, artist or
 * id leaves this module, and the AI boundary (`ai-boundary.test.ts`) stays as
 * narrow as it was.
 */
export async function countProfileMusic(userId: string): Promise<number> {
  return prisma.profileMusicTrack.count({ where: { userId } });
}

/** One entry of `PUT /v1/me/music` — which track, at which provider. */
export type MusicTrackRef =
  | { provider: "spotify"; trackId: string }
  | { provider: "apple_music"; trackId: string; storefront: string };

/**
 * A client's list → validated refs, or null. Shape only: whether the provider
 * actually serves the id is asked afterwards.
 */
export function parseTrackRefs(input: unknown): MusicTrackRef[] | null {
  if (!Array.isArray(input)) return null;
  const refs: MusicTrackRef[] = [];
  for (const item of input as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const { provider, trackId, storefront } = item as Record<string, unknown>;
    if (provider === "spotify" && isSpotifyTrackId(trackId)) {
      refs.push({ provider, trackId });
    } else if (
      provider === "apple_music" &&
      isAppleMusicSongId(trackId) &&
      isStorefront(storefront)
    ) {
      refs.push({ provider, trackId, storefront });
    } else {
      return null;
    }
  }
  return refs;
}

/** The provider's own word on one ref. */
async function resolveTrack(
  ref: MusicTrackRef,
  options: { fresh?: boolean } = {},
): Promise<MusicResult<StoredMusicTrack>> {
  if (ref.provider === "apple_music") {
    return getAppleMusicSong(ref.trackId, ref.storefront, options);
  }
  const found = await getTrack(ref.trackId, options);
  return found.ok ? { ok: true, value: { ...found.value, storefront: null, isrc: null } } : found;
}

function rowData(track: StoredMusicTrack) {
  return {
    provider: track.provider,
    trackId: track.trackId,
    storefront: track.storefront,
    isrc: track.isrc,
    title: track.title,
    artists: track.artists,
    albumName: track.albumName,
    coverUrl: track.coverUrl,
    trackUrl: track.url,
    previewUrl: track.previewUrl,
    explicit: track.explicit,
  };
}

function toShown(track: StoredMusicTrack): MusicTrack {
  const { storefront: _storefront, isrc: _isrc, ...shown } = track;
  return shown;
}

export type SetProfileMusicError =
  | "invalid_tracks"
  | "too_many_tracks"
  | "duplicate_tracks"
  | "track_not_found"
  | Exclude<MusicError, "not_found">;

export type SetProfileMusicResult =
  | { ok: true; tracks: MusicTrack[] }
  | { ok: false; error: SetProfileMusicError };

/**
 * Replace the pinned set with `input` (`[{ provider, trackId, storefront? }]`),
 * in that order. An empty list clears it — which is also the "disconnect"
 * Spotify's Terms ask for: nothing of a provider's is left behind.
 */
export async function setProfileMusic(
  userId: string,
  input: unknown,
): Promise<SetProfileMusicResult> {
  const refs = parseTrackRefs(input);
  if (!refs) return { ok: false, error: "invalid_tracks" };
  if (refs.length > MAX_PROFILE_TRACKS) return { ok: false, error: "too_many_tracks" };
  if (new Set(refs.map((ref) => `${ref.provider}:${ref.trackId}`)).size !== refs.length) {
    return { ok: false, error: "duplicate_tracks" };
  }

  // Every ref is resolved to the provider's own metadata BEFORE the table is
  // touched. The client sends ids only, so what a partner reads on this profile
  // is what Spotify or Apple says about those ids — never a title or an image
  // the client chose.
  const tracks: StoredMusicTrack[] = [];
  for (const ref of refs) {
    const found = await resolveTrack(ref);
    if (!found.ok) {
      return { ok: false, error: found.error === "not_found" ? "track_not_found" : found.error };
    }
    tracks.push(found.value);
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.profileMusicTrack.deleteMany({ where: { userId } }),
    prisma.profileMusicTrack.createMany({
      data: tracks.map((track, position) => ({
        userId,
        position,
        ...rowData(track),
        refreshedAt: now,
      })),
    }),
  ]);
  clearTopTracksImport(userId);
  return { ok: true, tracks: tracks.map(toShown) };
}

export interface MusicRefreshResult {
  refreshed: number;
  removed: number;
  failed: number;
}

/**
 * Nightly: re-read the metadata of rows older than a week. A track its
 * provider no longer serves is deleted rather than shown stale; an outage
 * leaves the rows alone for the next night. One provider out of quota stops
 * only its own rows — the other provider carries on.
 */
export async function refreshStaleMusicTracks(now = new Date()): Promise<MusicRefreshResult> {
  const rows = await prisma.profileMusicTrack.findMany({
    where: { refreshedAt: { lt: new Date(now.getTime() - REFRESH_AFTER_MS) } },
    select: { provider: true, trackId: true, storefront: true },
    orderBy: { refreshedAt: "asc" },
    take: REFRESH_BATCH,
  });

  const refs = new Map<string, MusicTrackRef>();
  for (const row of rows) {
    const provider: MusicProvider = isMusicProvider(row.provider) ? row.provider : "spotify";
    if (provider === "apple_music") {
      if (!row.storefront) continue;
      refs.set(`${provider}:${row.storefront}:${row.trackId}`, {
        provider,
        trackId: row.trackId,
        storefront: row.storefront,
      });
    } else {
      refs.set(`${provider}:${row.trackId}`, { provider, trackId: row.trackId });
    }
  }

  const result: MusicRefreshResult = { refreshed: 0, removed: 0, failed: 0 };
  const stopped = new Set<MusicProvider>();
  for (const ref of refs.values()) {
    if (stopped.has(ref.provider)) continue;
    const where = {
      provider: ref.provider,
      trackId: ref.trackId,
      ...(ref.provider === "apple_music" ? { storefront: ref.storefront } : {}),
    };
    const found = await resolveTrack(ref, { fresh: true });
    if (found.ok) {
      const updated = await prisma.profileMusicTrack.updateMany({
        where,
        data: { ...rowData(found.value), refreshedAt: now },
      });
      result.refreshed += updated.count;
    } else if (found.error === "not_found") {
      const deleted = await prisma.profileMusicTrack.deleteMany({ where });
      result.removed += deleted.count;
    } else {
      result.failed += 1;
      // Out of quota or unconfigured: every further call to that provider hits
      // the same wall, so its rows wait for tomorrow's run.
      if (found.error === "rate_limited" || found.error === "not_configured") {
        stopped.add(ref.provider);
      }
    }
  }
  return result;
}
