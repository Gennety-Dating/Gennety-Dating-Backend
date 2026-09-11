import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "./spotify.js";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  getTrack: vi.fn(),
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
vi.mock("./spotify-oauth.js", () => ({ clearTopTracksImport: h.clearTopTracksImport }));

const { setProfileMusic, refreshStaleMusicTracks, listProfileMusic } = await import(
  "./profile-music.js"
);

const USER = "11111111-1111-4111-8111-111111111111";
const A = "4uLU6hMCjMI75M1A2tKUQC";
const B = "7GhIk7Il098yCjg4BQjzvb";
const C = "0VjIjW4GlUZAMYd2vXMi3b";
const D = "3n3Ppam7vgaVa1iaRUc9Lp";
const WEEK = 7 * 24 * 60 * 60 * 1000;

function track(id: string): MusicTrack {
  return {
    spotifyTrackId: id,
    title: `Title ${id}`,
    artists: "Artist",
    albumName: "Album",
    coverUrl: "https://i.scdn.co/image/300",
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    previewUrl: null,
    explicit: false,
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
});

describe("setProfileMusic — refused before anyone is asked", () => {
  it.each([
    ["not a list", A, "invalid_track_ids"],
    ["a non-id inside", [A, "../etc/passwd"], "invalid_track_ids"],
    ["four tracks", [A, B, C, D], "too_many_tracks"],
    ["the same track twice", [A, A], "duplicate_tracks"],
  ])("%s", async (_label, input, error) => {
    expect(await setProfileMusic(USER, input)).toEqual({ ok: false, error });
    expect(h.getTrack).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("setProfileMusic — saving", () => {
  it("stores Spotify's metadata for each id, in the order given", async () => {
    const result = await setProfileMusic(USER, [B, A]);

    expect(result).toEqual({ ok: true, tracks: [track(B), track(A)] });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(h.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: USER, position: 0, spotifyTrackId: B, title: `Title ${B}` }),
        expect.objectContaining({ userId: USER, position: 1, spotifyTrackId: A }),
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
    h.getTrack.mockImplementation(async (id: string) =>
      id === B ? { ok: false, error: "not_found" } : { ok: true, value: track(id) },
    );
    expect(await setProfileMusic(USER, [A, B])).toEqual({ ok: false, error: "track_not_found" });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("passes Spotify's own trouble through untouched", async () => {
    h.getTrack.mockResolvedValue({ ok: false, error: "rate_limited" });
    expect(await setProfileMusic(USER, [A])).toEqual({ ok: false, error: "rate_limited" });
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("listProfileMusic", () => {
  it("reads the caller's rows in display order", async () => {
    h.findMany.mockResolvedValue([track(A)]);
    expect(await listProfileMusic(USER)).toEqual([track(A)]);
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER }, orderBy: { position: "asc" } }),
    );
  });
});

describe("refreshStaleMusicTracks", () => {
  const NOW = new Date("2026-09-11T04:20:00Z");

  it("refreshes what Spotify still serves and deletes what it dropped", async () => {
    h.findMany.mockResolvedValue([{ spotifyTrackId: A }, { spotifyTrackId: B }, { spotifyTrackId: A }]);
    h.getTrack.mockImplementation(async (id: string) =>
      id === B ? { ok: false, error: "not_found" } : { ok: true, value: { ...track(id), title: "Fresh" } },
    );
    h.updateMany.mockResolvedValue({ count: 2 });
    h.deleteMany.mockResolvedValue({ count: 1 });

    expect(await refreshStaleMusicTracks(NOW)).toEqual({ refreshed: 2, removed: 1, failed: 0 });
    // A is asked once even though two profiles pinned it.
    expect(h.getTrack).toHaveBeenCalledTimes(2);
    expect(h.getTrack).toHaveBeenCalledWith(A, { fresh: true });
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { refreshedAt: { lt: new Date(NOW.getTime() - WEEK) } } }),
    );
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { spotifyTrackId: A },
      data: expect.objectContaining({ title: "Fresh", refreshedAt: NOW }),
    });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { spotifyTrackId: B } });
  });

  it("stops at Spotify's quota instead of walking the batch into it", async () => {
    h.findMany.mockResolvedValue([{ spotifyTrackId: A }, { spotifyTrackId: B }, { spotifyTrackId: C }]);
    h.getTrack.mockImplementation(async (id: string) => ({
      ok: false,
      error: id === A ? "upstream_unavailable" : "rate_limited",
    }));

    expect(await refreshStaleMusicTracks(NOW)).toEqual({ refreshed: 0, removed: 0, failed: 2 });
    expect(h.getTrack).toHaveBeenCalledTimes(2);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.deleteMany).not.toHaveBeenCalled();
  });
});
