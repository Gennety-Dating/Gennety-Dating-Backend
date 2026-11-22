import { beforeEach, describe, expect, it, vi } from "vitest";
import { type MusicTrack, type StoredMusicTrack, withLegacyMusicFields } from "./track.js";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  getTrack: vi.fn(),
  getAppleMusicSong: vi.fn(),
  clearTopTracksImport: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    profileMusicTrack: {
      findMany: h.findMany,
      deleteMany: h.deleteMany,
      createMany: h.createMany,
      updateMany: h.updateMany,
    },
    $transaction: h.transaction,
  },
}));
vi.mock("./spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spotify.js")>()),
  getTrack: h.getTrack,
}));
vi.mock("./apple-music.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./apple-music.js")>()),
  getAppleMusicSong: h.getAppleMusicSong,
}));
vi.mock("./spotify-oauth.js", () => ({ clearTopTracksImport: h.clearTopTracksImport }));

const {
  appendProfileMusic,
  profileMusicKeys,
  setProfileMusic,
  refreshStaleMusicTracks,
  listProfileMusic,
  serializeMusicTrack,
} = await import("./profile-music.js");

const USER = "11111111-1111-4111-8111-111111111111";
const A = "4uLU6hMCjMI75M1A2tKUQC";
const B = "7GhIk7Il098yCjg4BQjzvb";
const C = "0VjIjW4GlUZAMYd2vXMi3b";
const SONG = "1440857781";
const SONG_2 = "1613600188";
const WEEK = 7 * 24 * 60 * 60 * 1000;

/** `n` distinct well-formed Spotify ids. */
const ids = (n: number, prefix = "x") =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`.padEnd(22, "Q"));

const spotify = (trackId: string) => ({ provider: "spotify", trackId });
const apple = (trackId: string, storefront = "ua") => ({ provider: "apple_music", trackId, storefront });

function track(id: string): MusicTrack {
  return {
    provider: "spotify",
    trackId: id,
    title: `Title ${id}`,
    artists: "Artist",
    albumName: "Album",
    coverUrl: "https://i.scdn.co/image/300",
    url: `https://open.spotify.com/track/${id}`,
    previewUrl: null,
    explicit: false,
    storefront: null,
  };
}

function song(id: string, storefront = "ua"): StoredMusicTrack {
  return {
    provider: "apple_music",
    trackId: id,
    title: `Song ${id}`,
    artists: "Singer",
    albumName: "Record",
    coverUrl: "https://is1-ssl.mzstatic.com/image/thumb/a/300x300bb.jpg",
    url: `https://music.apple.com/${storefront}/album/record/1?i=${id}`,
    previewUrl: "https://audio-ssl.itunes.apple.com/preview.m4a",
    explicit: false,
    storefront,
    isrc: "USUM71900001",
  };
}

/** What leaves the server: the shape plus the pre-2026-10-08 names (K-01). */
const wire = withLegacyMusicFields;

beforeEach(() => {
  h.findMany.mockResolvedValue([]);
  h.transaction.mockImplementation(async (operations: Promise<unknown>[]) =>
    Promise.all(operations),
  );
  h.deleteMany.mockResolvedValue({ count: 0 });
  h.createMany.mockResolvedValue({ count: 0 });
  h.updateMany.mockResolvedValue({ count: 0 });
  h.getTrack.mockImplementation(async (id: string) => ({ ok: true, value: track(id) }));
  h.getAppleMusicSong.mockImplementation(async (id: string, storefront: string) => ({
    ok: true,
    value: song(id, storefront),
  }));
});

describe("setProfileMusic — refused before anyone is asked", () => {
  it.each([
    ["not a list", spotify(A), "invalid_tracks"],
    ["a bare id instead of a ref", [A], "invalid_tracks"],
    ["a non-id inside", [spotify(A), spotify("../etc/passwd")], "invalid_tracks"],
    ["an unknown provider", [{ provider: "deezer", trackId: A }], "invalid_tracks"],
    ["an Apple song without a storefront", [{ provider: "apple_music", trackId: SONG }], "invalid_tracks"],
    ["an Apple library id", [apple("i.PkdJvPXI2AJgm8")], "invalid_tracks"],
    ["a Spotify id passed as Apple's", [apple(A)], "invalid_tracks"],
    ["31 tracks", [...ids(30).map(spotify), apple(SONG)], "too_many_tracks"],
    ["the same track twice", [spotify(A), spotify(A)], "duplicate_tracks"],
    ["the same song from two storefronts", [apple(SONG, "ua"), apple(SONG, "us")], "duplicate_tracks"],
  ])("%s", async (_label, input, error) => {
    expect(await setProfileMusic(USER, input)).toEqual({ ok: false, error });
    expect(h.getTrack).not.toHaveBeenCalled();
    expect(h.getAppleMusicSong).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("setProfileMusic — saving", () => {
  it("stores each provider's own metadata, in the order given", async () => {
    const result = await setProfileMusic(USER, [apple(SONG), spotify(A)]);

    // The answer is what a partner will see — no ISRC.
    const { isrc: _i, ...shownSong } = song(SONG);
    expect(result).toEqual({ ok: true, tracks: [wire(shownSong), wire(track(A))] });
    expect(h.getAppleMusicSong).toHaveBeenCalledWith(SONG, "ua", {});
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(h.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: USER,
          position: 0,
          provider: "apple_music",
          trackId: SONG,
          storefront: "ua",
          isrc: "USUM71900001",
          title: `Song ${SONG}`,
          trackUrl: `https://music.apple.com/ua/album/record/1?i=${SONG}`,
        }),
        expect.objectContaining({
          userId: USER,
          position: 1,
          provider: "spotify",
          trackId: A,
          storefront: null,
          isrc: null,
          trackUrl: `https://open.spotify.com/track/${A}`,
        }),
      ],
    });
    // The import has served its purpose — Spotify's personal data does not linger.
    expect(h.clearTopTracksImport).toHaveBeenCalledWith(USER);
  });

  it("keeps already-pinned tracks as stored instead of asking the provider again (K-04)", async () => {
    const old = new Date("2026-10-01T00:00:00Z");
    const stored = (t: StoredMusicTrack) => {
      const { url, ...rest } = t;
      return { ...rest, trackUrl: url, refreshedAt: old };
    };
    h.findMany.mockResolvedValue([stored(song(SONG)), stored({ ...track(A), isrc: null })]);

    // Removing B from [SONG, A, B] re-sends SONG and A; neither is re-read.
    const result = await setProfileMusic(USER, [apple(SONG), spotify(A)]);
    const { isrc: _i, ...shownSong } = song(SONG);
    expect(result).toEqual({ ok: true, tracks: [wire(shownSong), wire(track(A))] });
    expect(h.getTrack).not.toHaveBeenCalled();
    expect(h.getAppleMusicSong).not.toHaveBeenCalled();
    expect(h.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ position: 0, trackId: SONG, isrc: "USUM71900001", refreshedAt: old }),
        expect.objectContaining({ position: 1, trackId: A, refreshedAt: old }),
      ],
    });
  });

  it("still resolves a newly added track, and a kept song from another storefront", async () => {
    h.findMany.mockResolvedValue([
      { ...song(SONG), trackUrl: song(SONG).url, refreshedAt: new Date() },
    ]);
    await setProfileMusic(USER, [apple(SONG, "us"), spotify(B)]);
    expect(h.getAppleMusicSong).toHaveBeenCalledWith(SONG, "us", {});
    expect(h.getTrack).toHaveBeenCalledWith(B, {});
  });

  it("takes 30 tracks — the cap since 2026-11-22", async () => {
    const refs = [...ids(29).map(spotify), apple(SONG)];
    const result = await setProfileMusic(USER, refs);
    expect(result.ok).toBe(true);
    expect(h.createMany).toHaveBeenCalledWith({
      data: refs.map((ref, position) =>
        expect.objectContaining({ position, trackId: ref.trackId }),
      ),
    });
  });

  it("an empty list clears the set", async () => {
    expect(await setProfileMusic(USER, [])).toEqual({ ok: true, tracks: [] });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(h.createMany).toHaveBeenCalledWith({ data: [] });
  });

  it("saves nothing when one id does not resolve", async () => {
    h.getAppleMusicSong.mockResolvedValue({ ok: false, error: "not_found" });
    expect(await setProfileMusic(USER, [spotify(A), apple(SONG)])).toEqual({
      ok: false,
      error: "track_not_found",
    });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("passes a provider's own trouble through untouched", async () => {
    h.getTrack.mockResolvedValue({ ok: false, error: "rate_limited" });
    expect(await setProfileMusic(USER, [spotify(A)])).toEqual({ ok: false, error: "rate_limited" });
    h.getAppleMusicSong.mockResolvedValue({ ok: false, error: "not_configured" });
    expect(await setProfileMusic(USER, [apple(SONG)])).toEqual({ ok: false, error: "not_configured" });
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("listProfileMusic", () => {
  it("reads the caller's rows in display order, as the API shape", async () => {
    h.findMany.mockResolvedValue([
      { ...track(A), trackUrl: track(A).url, url: undefined },
    ]);
    expect(await listProfileMusic(USER)).toEqual([wire(track(A))]);
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER }, orderBy: { position: "asc" } }),
    );
  });

  it("also emits the pre-2026-10-08 names old builds decode (K-01)", () => {
    const shown = serializeMusicTrack({ ...song(SONG), trackUrl: song(SONG).url });
    expect(shown.spotifyTrackId).toBe(SONG);
    expect(shown.spotifyUrl).toBe(song(SONG).url);
    expect(shown.trackId).toBe(SONG);
    expect(shown.url).toBe(song(SONG).url);
  });

  it("reads a row from before providers as Spotify's", () => {
    const row = { ...track(A), provider: "", trackUrl: track(A).url };
    expect(serializeMusicTrack(row).provider).toBe("spotify");
  });
});

describe("refreshStaleMusicTracks", () => {
  const NOW = new Date("2026-10-08T04:20:00Z");

  it("refreshes what each provider still serves and deletes what it dropped", async () => {
    h.findMany.mockResolvedValue([
      { provider: "spotify", trackId: A, storefront: null },
      { provider: "spotify", trackId: B, storefront: null },
      { provider: "spotify", trackId: A, storefront: null },
      { provider: "apple_music", trackId: SONG, storefront: "ua" },
    ]);
    h.getTrack.mockImplementation(async (id: string) =>
      id === B ? { ok: false, error: "not_found" } : { ok: true, value: { ...track(id), title: "Fresh" } },
    );
    h.updateMany.mockResolvedValue({ count: 2 });
    h.deleteMany.mockResolvedValue({ count: 1 });

    expect(await refreshStaleMusicTracks(NOW)).toEqual({ refreshed: 4, removed: 1, failed: 0 });
    // A is asked once even though two profiles pinned it.
    expect(h.getTrack).toHaveBeenCalledTimes(2);
    expect(h.getTrack).toHaveBeenCalledWith(A, { fresh: true });
    expect(h.getAppleMusicSong).toHaveBeenCalledWith(SONG, "ua", { fresh: true });
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { refreshedAt: { lt: new Date(NOW.getTime() - WEEK) } } }),
    );
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { provider: "spotify", trackId: A },
      data: expect.objectContaining({ title: "Fresh", refreshedAt: NOW }),
    });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { provider: "apple_music", trackId: SONG, storefront: "ua" },
      data: expect.objectContaining({ title: `Song ${SONG}`, refreshedAt: NOW }),
    });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { provider: "spotify", trackId: B } });
  });

  it("stops one provider at its quota and lets the other carry on", async () => {
    h.findMany.mockResolvedValue([
      { provider: "spotify", trackId: A, storefront: null },
      { provider: "spotify", trackId: B, storefront: null },
      { provider: "spotify", trackId: C, storefront: null },
      { provider: "apple_music", trackId: SONG, storefront: "ua" },
      { provider: "apple_music", trackId: SONG_2, storefront: "ua" },
    ]);
    h.getTrack.mockImplementation(async (id: string) => ({
      ok: false,
      error: id === A ? "upstream_unavailable" : "rate_limited",
    }));
    h.updateMany.mockResolvedValue({ count: 1 });

    expect(await refreshStaleMusicTracks(NOW)).toEqual({ refreshed: 2, removed: 0, failed: 2 });
    expect(h.getTrack).toHaveBeenCalledTimes(2);
    expect(h.getAppleMusicSong).toHaveBeenCalledTimes(2);
    expect(h.deleteMany).not.toHaveBeenCalled();
  });
});

/** A stored row as `findMany` returns it for a pinned Spotify track. */
function pinnedRow(id: string, position = 0) {
  const t = track(id);
  return {
    provider: "spotify",
    trackId: id,
    title: t.title,
    artists: t.artists,
    albumName: t.albumName,
    coverUrl: t.coverUrl,
    trackUrl: t.url,
    previewUrl: null,
    explicit: false,
    storefront: null,
    isrc: null,
    refreshedAt: new Date(0),
    position,
  };
}

describe("appendProfileMusic — «Добавить N» from a shared playlist", () => {
  it("appends after what is pinned and keeps the pinned rows unread", async () => {
    h.findMany.mockResolvedValue([pinnedRow(A)]);
    const result = await appendProfileMusic(USER, [spotify(B), apple(SONG)]);
    expect(result).toMatchObject({
      ok: true,
      added: 2,
      skipped: { duplicate: 0, notFound: 0, overLimit: 0, failed: 0 },
    });
    expect(h.getTrack).toHaveBeenCalledTimes(1);
    expect(h.getTrack).toHaveBeenCalledWith(B, {});
    expect(h.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ position: 0, trackId: A, refreshedAt: new Date(0) }),
        expect.objectContaining({ position: 1, trackId: B }),
        expect.objectContaining({ position: 2, trackId: SONG, storefront: "ua" }),
      ],
    });
    expect(h.clearTopTracksImport).toHaveBeenCalledWith(USER);
  });

  it("skips an id already pinned, one sent twice, and the same song from another provider", async () => {
    h.findMany.mockResolvedValue([pinnedRow(A)]);
    // The Apple song is «Title A» by «Artist» — the pinned Spotify track.
    h.getAppleMusicSong.mockResolvedValue({
      ok: true,
      value: { ...song(SONG), title: `Title ${A} (Remastered)`, artists: "Artist" },
    });
    const result = await appendProfileMusic(USER, [spotify(A), spotify(B), spotify(B), apple(SONG)]);
    expect(result).toMatchObject({ ok: true, added: 1, skipped: { duplicate: 3 } });
  });

  it("fills only the free slots and never asks the provider about the rest", async () => {
    h.findMany.mockResolvedValue(ids(28, "p").map((id, i) => pinnedRow(id, i)));
    const result = await appendProfileMusic(USER, ids(5, "n").map(spotify));
    expect(result).toMatchObject({ ok: true, added: 2, skipped: { overLimit: 3 } });
    expect(h.getTrack).toHaveBeenCalledTimes(2);
  });

  it("lets the next track take the slot of one the provider dropped", async () => {
    h.findMany.mockResolvedValue(ids(29, "p").map((id, i) => pinnedRow(id, i)));
    const [gone, next] = ids(2, "n");
    h.getTrack.mockImplementation(async (id: string) =>
      id === gone ? { ok: false, error: "not_found" } : { ok: true, value: track(id) },
    );
    const result = await appendProfileMusic(USER, [spotify(gone!), spotify(next!)]);
    expect(result).toMatchObject({ ok: true, added: 1, skipped: { notFound: 1, overLimit: 0 } });
  });

  it("is refused when the profile is full, before any provider call", async () => {
    h.findMany.mockResolvedValue(ids(30, "p").map((id, i) => pinnedRow(id, i)));
    expect(await appendProfileMusic(USER, [spotify(A)])).toEqual({ ok: false, error: "too_many_tracks" });
    expect(h.getTrack).not.toHaveBeenCalled();
  });

  it("refuses a malformed or empty list, or more than one read can hold", async () => {
    expect(await appendProfileMusic(USER, [])).toEqual({ ok: false, error: "invalid_tracks" });
    expect(await appendProfileMusic(USER, [{ provider: "youtube", trackId: "x" }])).toEqual({
      ok: false,
      error: "invalid_tracks",
    });
    expect(await appendProfileMusic(USER, ids(31).map(spotify))).toEqual({
      ok: false,
      error: "too_many_tracks",
    });
  });

  it("passes the provider's trouble through when nothing could be added, and stops at its quota", async () => {
    h.getTrack.mockResolvedValue({ ok: false, error: "rate_limited" });
    expect(await appendProfileMusic(USER, ids(10).map(spotify))).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(h.getTrack.mock.calls.length).toBeLessThanOrEqual(4);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("keeps what it could read when the provider fails midway", async () => {
    const [first, second] = ids(2);
    h.getTrack.mockImplementation(async (id: string) =>
      id === first ? { ok: true, value: track(id) } : { ok: false, error: "upstream_unavailable" },
    );
    const result = await appendProfileMusic(USER, [spotify(first!), spotify(second!)]);
    expect(result).toMatchObject({ ok: true, added: 1, skipped: { failed: 1 } });
  });
});

describe("profileMusicKeys", () => {
  it("gives keys and a count, never a title", async () => {
    h.findMany.mockResolvedValue([pinnedRow(A)]);
    const keys = await profileMusicKeys(USER);
    expect(keys.count).toBe(1);
    expect([...keys.refs]).toEqual([`spotify:${A}`]);
    expect([...keys.titles]).toEqual([`title ${A.toLowerCase()}|artist`]);
  });
});
