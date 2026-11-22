import { prisma } from "@gennety/db";
import { PROFILE_MUSIC_MAX_TRACKS, SHARE_MUSIC_LOOKUP_CONCURRENCY, SHARE_MUSIC_MAX_TRACKS } from "@gennety/shared";
import { getAppleMusicSong, isAppleMusicSongId, isStorefront } from "./apple-music.js";
import { getTrack, isSpotifyTrackId } from "./spotify.js";
import { clearTopTracksImport } from "./spotify-oauth.js";
import {
  isMusicProvider,
  musicTitleKey,
  type MusicError,
  type MusicProvider,
  type MusicResult,
  type StoredMusicTrack,
  type WireMusicTrack,
  withLegacyMusicFields,
} from "./track.js";

/**
 * The tracks pinned to a profile (decisions 2026-09-11, 2026-10-08).
 * Display-only — read the `ProfileMusicTrack` model comment before adding a
 * reader anywhere else.
 */

/**
 * The product rule: a profile holds at most 30 tracks (three until 2026-10-19,
 * five until 2026-11-22, raised so a shared playlist lands whole). The value
 * lives in shared constants.
 */
export const MAX_PROFILE_TRACKS = PROFILE_MUSIC_MAX_TRACKS;

/** A week, then the provider is asked again (Spotify's Terms: shown data must be current). */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Rows looked at per nightly run; the rest wait for the next night. 200 until
 * the cap went from five to 30 tracks (2026-11-22): a week of rows grows with
 * it, and each Spotify row is its own request (no batch in development mode).
 */
const REFRESH_BATCH = 1_000;

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
  storefront: true,
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
  storefront: string | null;
};

export function serializeMusicTrack(row: MusicTrackRow): WireMusicTrack {
  return withLegacyMusicFields({
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
    storefront: row.storefront,
  });
}

export async function listProfileMusic(userId: string): Promise<WireMusicTrack[]> {
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

/**
 * The body of `PUT /v1/me/music` → what `setProfileMusic` takes. Builds from
 * before 2026-10-08 send `{ trackIds: ["<spotify id>", …] }` (Spotify was the
 * only provider then); that shape is read as Spotify refs so those builds can
 * still save. Anything malformed falls through to the normal validation.
 */
export function musicSaveInput(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const { tracks, trackIds } = body as { tracks?: unknown; trackIds?: unknown };
  if (tracks !== undefined || !Array.isArray(trackIds)) return tracks;
  return trackIds.map((trackId: unknown) =>
    typeof trackId === "string" ? { provider: "spotify", trackId } : trackId,
  );
}

function refKey(ref: { provider: string; trackId: string; storefront?: string | null }): string {
  return ref.provider === "apple_music"
    ? `${ref.provider}:${ref.storefront ?? ""}:${ref.trackId}`
    : `${ref.provider}:${ref.trackId}`;
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
  return found.ok ? { ok: true, value: { ...found.value, isrc: null } } : found;
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

function toShown(track: StoredMusicTrack): WireMusicTrack {
  const { isrc: _isrc, ...shown } = track;
  return withLegacyMusicFields(shown);
}

export type SetProfileMusicError =
  | "invalid_tracks"
  | "too_many_tracks"
  | "duplicate_tracks"
  | "track_not_found"
  | Exclude<MusicError, "not_found">;

export type SetProfileMusicResult =
  | { ok: true; tracks: WireMusicTrack[] }
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
  //
  // A track already pinned is not asked again (audit K-04): removing one of
  // three re-sends the other two, and those rows already hold the provider's
  // answer — re-reading them only spends quota and turns a provider outage
  // into a failed removal. They keep their `refreshedAt`, so the nightly
  // refresh still re-reads them on its usual schedule.
  const pinned = new Map<string, { track: StoredMusicTrack; refreshedAt: Date }>();
  if (refs.length > 0) {
    const rows = await prisma.profileMusicTrack.findMany({
      where: { userId },
      select: { ...MUSIC_TRACK_SELECT, isrc: true, refreshedAt: true },
    });
    for (const { isrc, refreshedAt, ...row } of rows) {
      const { spotifyTrackId: _id, spotifyUrl: _url, ...shown } = serializeMusicTrack(row);
      pinned.set(refKey(shown), { track: { ...shown, isrc }, refreshedAt });
    }
  }

  const now = new Date();
  const tracks: { track: StoredMusicTrack; refreshedAt: Date }[] = [];
  for (const ref of refs) {
    const kept = pinned.get(refKey(ref));
    if (kept) {
      tracks.push(kept);
      continue;
    }
    const found = await resolveTrack(ref);
    if (!found.ok) {
      return { ok: false, error: found.error === "not_found" ? "track_not_found" : found.error };
    }
    tracks.push({ track: found.value, refreshedAt: now });
  }

  await prisma.$transaction([
    prisma.profileMusicTrack.deleteMany({ where: { userId } }),
    prisma.profileMusicTrack.createMany({
      data: tracks.map(({ track, refreshedAt }, position) => ({
        userId,
        position,
        ...rowData(track),
        refreshedAt,
      })),
    }),
  ]);
  clearTopTracksImport(userId);
  return { ok: true, tracks: tracks.map(({ track }) => toShown(track)) };
}

/**
 * What the share sheet's playlist read needs to mark a track «already on your
 * profile» — keys and a count, never a title or an artist, so no track data
 * leaves this allow-listed reader (`ai-boundary.test.ts`).
 */
export interface ProfileMusicKeys {
  /** `provider:trackId` of every pinned track. */
  refs: Set<string>;
  /** `musicTitleKey` of every pinned track — the same song from another provider. */
  titles: Set<string>;
  count: number;
}

export async function profileMusicKeys(userId: string): Promise<ProfileMusicKeys> {
  const rows = await prisma.profileMusicTrack.findMany({
    where: { userId },
    select: { provider: true, trackId: true, title: true, artists: true },
  });
  return {
    refs: new Set(rows.map((row) => `${row.provider}:${row.trackId}`)),
    titles: new Set(rows.map((row) => musicTitleKey(row.title, row.artists))),
    count: rows.length,
  };
}

export type AppendProfileMusicError =
  | "invalid_tracks"
  | "too_many_tracks"
  | Exclude<MusicError, "not_found">;

export interface AppendProfileMusicSkipped {
  /** Already on the profile (same id, or the same song from another provider), or sent twice. */
  duplicate: number;
  /** The provider no longer serves the id. */
  notFound: number;
  /** Past the profile cap. */
  overLimit: number;
  /** The provider was out or out of quota for this one. */
  failed: number;
}

export type AppendProfileMusicResult =
  | { ok: true; tracks: WireMusicTrack[]; added: number; skipped: AppendProfileMusicSkipped }
  | { ok: false; error: AppendProfileMusicError };

/**
 * «Добавить N» from a shared playlist (decision 2026-11-22): append refs to the
 * END of the pinned set, keeping what is there. Unlike `setProfileMusic` it is
 * forgiving — one bad id does not sink a 30-track import: duplicates, ids the
 * provider dropped and tracks past the cap are skipped and counted. The rule
 * that matters is unchanged: every new row is the provider's own answer for
 * its id, never a title or a cover the client sent.
 *
 * Fails as a whole only when the list is malformed, when the profile is
 * already full, or when not one new track could be read because the
 * provider was down (that error is passed through).
 */
export async function appendProfileMusic(
  userId: string,
  input: unknown,
): Promise<AppendProfileMusicResult> {
  const refs = parseTrackRefs(input);
  if (!refs || refs.length === 0) return { ok: false, error: "invalid_tracks" };
  if (refs.length > SHARE_MUSIC_MAX_TRACKS) return { ok: false, error: "too_many_tracks" };

  const rows = await prisma.profileMusicTrack.findMany({
    where: { userId },
    orderBy: { position: "asc" },
    select: { ...MUSIC_TRACK_SELECT, isrc: true, refreshedAt: true },
  });
  const kept = rows.map(({ isrc, refreshedAt, ...row }) => {
    const { spotifyTrackId: _id, spotifyUrl: _url, ...shown } = serializeMusicTrack(row);
    return { track: { ...shown, isrc } as StoredMusicTrack, refreshedAt };
  });
  const slots = MAX_PROFILE_TRACKS - kept.length;
  if (slots <= 0) return { ok: false, error: "too_many_tracks" };

  const skipped: AppendProfileMusicSkipped = { duplicate: 0, notFound: 0, overLimit: 0, failed: 0 };
  const seenRefs = new Set(kept.map(({ track }) => `${track.provider}:${track.trackId}`));
  const seenTitles = new Set(kept.map(({ track }) => musicTitleKey(track.title, track.artists)));
  const fresh: MusicTrackRef[] = [];
  for (const ref of refs) {
    const key = `${ref.provider}:${ref.trackId}`;
    if (seenRefs.has(key)) {
      skipped.duplicate += 1;
      continue;
    }
    seenRefs.add(key);
    fresh.push(ref);
  }

  // Read in order, only as many as the free slots still need: a dropped id or
  // a same-song duplicate found after its read lets the next ref take the slot,
  // and nothing past the cap is ever asked of the provider.
  const added: StoredMusicTrack[] = [];
  let lastError: MusicError | null = null;
  let cursor = 0;
  while (cursor < fresh.length && added.length < slots) {
    // At most one concurrency window per round, so a provider's wall is seen
    // after a handful of calls rather than after the whole list.
    const size = Math.min(slots - added.length, SHARE_MUSIC_LOOKUP_CONCURRENCY);
    const batch = fresh.slice(cursor, cursor + size);
    cursor += batch.length;
    const reads = await Promise.all(batch.map((ref) => resolveTrack(ref)));
    for (const found of reads) {
      if (!found.ok) {
        if (found.error === "not_found") skipped.notFound += 1;
        else {
          skipped.failed += 1;
          lastError = found.error;
        }
        continue;
      }
      const titleKey = musicTitleKey(found.value.title, found.value.artists);
      if (seenTitles.has(titleKey)) {
        skipped.duplicate += 1;
        continue;
      }
      seenTitles.add(titleKey);
      added.push(found.value);
    }
    // Out of quota or unconfigured: every further call hits the same wall.
    if (lastError === "rate_limited" || lastError === "not_configured") break;
  }
  // What was never asked: past the cap normally, or behind a provider's wall.
  const unread = fresh.length - cursor;
  if (added.length < slots && lastError) skipped.failed += unread;
  else skipped.overLimit += unread;
  if (added.length === 0 && lastError) return { ok: false, error: lastError };

  const now = new Date();
  const tracks = [...kept, ...added.map((track) => ({ track, refreshedAt: now }))];
  if (added.length > 0) {
    await prisma.$transaction([
      prisma.profileMusicTrack.deleteMany({ where: { userId } }),
      prisma.profileMusicTrack.createMany({
        data: tracks.map(({ track, refreshedAt }, position) => ({
          userId,
          position,
          ...rowData(track),
          refreshedAt,
        })),
      }),
    ]);
    clearTopTracksImport(userId);
  }
  return {
    ok: true,
    tracks: tracks.map(({ track }) => toShown(track)),
    added: added.length,
    skipped,
  };
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
