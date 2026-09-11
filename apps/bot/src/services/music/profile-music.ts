import { prisma } from "@gennety/db";
import { getTrack, isSpotifyTrackId, type MusicTrack } from "./spotify.js";
import { clearTopTracksImport } from "./spotify-oauth.js";

/**
 * The tracks pinned to a profile (decision 2026-09-11). Display-only — read the
 * `ProfileMusicTrack` model comment before adding a reader anywhere else.
 */

/** The product rule: a profile shows at most three tracks. */
export const MAX_PROFILE_TRACKS = 3;

/** A week, then Spotify is asked again (its Terms: shown data must be current). */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows looked at per nightly run; the rest wait for the next night. */
const REFRESH_BATCH = 200;

/** The columns every reader selects — one list, so a new field lands everywhere. */
export const MUSIC_TRACK_SELECT = {
  spotifyTrackId: true,
  title: true,
  artists: true,
  albumName: true,
  coverUrl: true,
  spotifyUrl: true,
  previewUrl: true,
  explicit: true,
} as const;

type MusicTrackRow = {
  spotifyTrackId: string;
  title: string;
  artists: string;
  albumName: string | null;
  coverUrl: string | null;
  spotifyUrl: string;
  previewUrl: string | null;
  explicit: boolean;
};

export function serializeMusicTrack(row: MusicTrackRow): MusicTrack {
  return {
    spotifyTrackId: row.spotifyTrackId,
    title: row.title,
    artists: row.artists,
    albumName: row.albumName,
    coverUrl: row.coverUrl,
    spotifyUrl: row.spotifyUrl,
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

export type SetProfileMusicError =
  | "invalid_track_ids"
  | "too_many_tracks"
  | "duplicate_tracks"
  | "track_not_found"
  | "not_configured"
  | "upstream_unavailable"
  | "rate_limited";

export type SetProfileMusicResult =
  | { ok: true; tracks: MusicTrack[] }
  | { ok: false; error: SetProfileMusicError };

/**
 * Replace the pinned set with `trackIds`, in that order. An empty list clears
 * it — which is also the "disconnect" the Spotify Terms ask for: nothing of
 * Spotify's is left behind for this person.
 */
export async function setProfileMusic(
  userId: string,
  trackIds: unknown,
): Promise<SetProfileMusicResult> {
  if (!Array.isArray(trackIds) || !trackIds.every(isSpotifyTrackId)) {
    return { ok: false, error: "invalid_track_ids" };
  }
  const ids: string[] = trackIds;
  if (ids.length > MAX_PROFILE_TRACKS) return { ok: false, error: "too_many_tracks" };
  if (new Set(ids).size !== ids.length) return { ok: false, error: "duplicate_tracks" };

  // Every id is resolved to Spotify's own metadata BEFORE the table is touched.
  // The client sends ids only, so what a partner reads on this profile is what
  // Spotify says about those ids — never a title or an image the client chose.
  const tracks: MusicTrack[] = [];
  for (const id of ids) {
    const found = await getTrack(id);
    if (!found.ok) {
      return { ok: false, error: found.error === "not_found" ? "track_not_found" : found.error };
    }
    tracks.push(found.value);
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.profileMusicTrack.deleteMany({ where: { userId } }),
    prisma.profileMusicTrack.createMany({
      data: tracks.map((track, position) => ({ userId, position, ...track, refreshedAt: now })),
    }),
  ]);
  clearTopTracksImport(userId);
  return { ok: true, tracks };
}

export interface MusicRefreshResult {
  refreshed: number;
  removed: number;
  failed: number;
}

/**
 * Nightly: re-read the metadata of rows older than a week. A track Spotify no
 * longer serves is deleted rather than shown stale; a Spotify outage leaves
 * the rows alone for the next night.
 */
export async function refreshStaleMusicTracks(now = new Date()): Promise<MusicRefreshResult> {
  const rows = await prisma.profileMusicTrack.findMany({
    where: { refreshedAt: { lt: new Date(now.getTime() - REFRESH_AFTER_MS) } },
    select: { spotifyTrackId: true },
    orderBy: { refreshedAt: "asc" },
    take: REFRESH_BATCH,
  });
  const ids = [...new Set(rows.map((row) => row.spotifyTrackId))];

  const result: MusicRefreshResult = { refreshed: 0, removed: 0, failed: 0 };
  for (const id of ids) {
    const found = await getTrack(id, { fresh: true });
    if (found.ok) {
      const updated = await prisma.profileMusicTrack.updateMany({
        where: { spotifyTrackId: id },
        data: { ...found.value, refreshedAt: now },
      });
      result.refreshed += updated.count;
    } else if (found.error === "not_found") {
      const deleted = await prisma.profileMusicTrack.deleteMany({ where: { spotifyTrackId: id } });
      result.removed += deleted.count;
    } else {
      result.failed += 1;
      // Out of quota or unconfigured: every further call hits the same wall,
      // so stop here and let tomorrow's run carry on.
      if (found.error === "rate_limited" || found.error === "not_configured") break;
    }
  }
  return result;
}
