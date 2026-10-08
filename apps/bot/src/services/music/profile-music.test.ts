import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack, StoredMusicTrack } from "./track.js";

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

const { setProfileMusic, refreshStaleMusicTracks, listProfileMusic, serializeMusicTrack } =
  await import("./profile-music.js");

const USER = "11111111-1111-4111-8111-111111111111";
const A = "4uLU6hMCjMI75M1A2tKUQC";
const B = "7GhIk7Il098yCjg4BQjzvb";
const C = "0VjIjW4GlUZAMYd2vXMi3b";
const SONG = "1440857781";
const SONG_2 = "1613600188";
const WEEK = 7 * 24 * 60 * 60 * 1000;

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

beforeEach(() => {
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
    ["four tracks", [spotify(A), spotify(B), spotify(C), apple(SONG)], "too_many_tracks"],
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
    expect(result).toEqual({ ok: true, tracks: [shownSong, track(A)] });
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
    expect(await listProfileMusic(USER)).toEqual([track(A)]);
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER }, orderBy: { position: "asc" } }),
    );
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
