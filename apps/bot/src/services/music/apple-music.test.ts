import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A throwaway P-256 key in a temp file — the shape of a MusicKit .p8.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY_DIR = mkdtempSync(join(tmpdir(), "apple-music-test-"));
const KEY_PATH = join(KEY_DIR, "AuthKey_MUSIC.p8");
writeFileSync(KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }));

const env = {
  APPLE_MUSIC_KEY_PATH: KEY_PATH,
  APPLE_MUSIC_KEY_ID: "MUSICKEY01",
  APPLE_MUSIC_TEAM_ID: "TEAM123456",
};
vi.mock("../../config.js", () => ({ env }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const {
  getAppleMusicSong,
  mapAppleMusicSong,
  appleMusicDeveloperToken,
  appleMusicConfigured,
  __resetAppleMusicState,
} = await import("./apple-music.js");

const SONG_ID = "1440857781";

function rawSong(overrides: Record<string, unknown> = {}) {
  return {
    id: SONG_ID,
    type: "songs",
    attributes: {
      name: "Never Gonna Give You Up",
      artistName: "Rick Astley",
      albumName: "Whenever You Need Somebody",
      artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/{w}x{h}bb.jpg", width: 3000, height: 3000 },
      url: `https://music.apple.com/ua/album/never-gonna-give-you-up/1440857546?i=${SONG_ID}`,
      isrc: "GBARL9300135",
      previews: [{ url: "https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a" }],
      ...overrides,
    },
  };
}

function answer(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  __resetAppleMusicState();
  fetchMock.mockReset();
  env.APPLE_MUSIC_KEY_PATH = KEY_PATH;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("mapAppleMusicSong", () => {
  it("keeps Apple's facts, sizes the cover and carries storefront and ISRC", () => {
    expect(mapAppleMusicSong(rawSong(), "ua")).toEqual({
      provider: "apple_music",
      trackId: SONG_ID,
      title: "Never Gonna Give You Up",
      artists: "Rick Astley",
      albumName: "Whenever You Need Somebody",
      coverUrl: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/300x300bb.jpg",
      url: `https://music.apple.com/ua/album/never-gonna-give-you-up/1440857546?i=${SONG_ID}`,
      previewUrl: "https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a",
      explicit: false,
      storefront: "ua",
      isrc: "GBARL9300135",
    });
  });

  it("marks Apple's explicit rating", () => {
    expect(mapAppleMusicSong(rawSong({ contentRating: "explicit" }), "ua")?.explicit).toBe(true);
    expect(mapAppleMusicSong(rawSong({ contentRating: "clean" }), "ua")?.explicit).toBe(false);
  });

  it("refuses what cannot sit on a profile", () => {
    expect(mapAppleMusicSong(null, "ua")).toBeNull();
    expect(mapAppleMusicSong({ ...rawSong(), type: "albums" }, "ua")).toBeNull();
    expect(mapAppleMusicSong({ ...rawSong(), id: "i.PkdJvPXI2AJgm8" }, "ua")).toBeNull();
    expect(mapAppleMusicSong(rawSong({ name: "  " }), "ua")).toBeNull();
    // No link back to Apple Music — nothing to send the partner to.
    expect(mapAppleMusicSong(rawSong({ url: undefined }), "ua")).toBeNull();
    expect(mapAppleMusicSong(rawSong({ url: "http://music.apple.com/x" }), "ua")).toBeNull();
  });

  it("drops a cover or a preview that is not https", () => {
    const song = mapAppleMusicSong(
      rawSong({ artwork: { url: "http://x/{w}x{h}.jpg" }, previews: [{ url: "ftp://x" }] }),
      "ua",
    );
    expect(song?.coverUrl).toBeNull();
    expect(song?.previewUrl).toBeNull();
  });
});

describe("developer token", () => {
  it("is an ES256 JWT for our team and key, verifiable with the key's public half", () => {
    const token = appleMusicDeveloperToken();
    expect(token).toBeTypeOf("string");
    const decoded = jwt.verify(token as string, publicKey.export({ type: "spki", format: "pem" }), {
      algorithms: ["ES256"],
      complete: true,
    }) as jwt.Jwt;
    expect(decoded.header.kid).toBe("MUSICKEY01");
    expect((decoded.payload as jwt.JwtPayload).iss).toBe("TEAM123456");
  });

  it("is reused until shortly before it expires", () => {
    const now = Date.now();
    const first = appleMusicDeveloperToken(now);
    expect(appleMusicDeveloperToken(now + 60_000)).toBe(first);
  });
});

describe("getAppleMusicSong", () => {
  it("answers not_configured without calling Apple", async () => {
    env.APPLE_MUSIC_KEY_PATH = "";
    expect(appleMusicConfigured()).toBe(false);
    expect(await getAppleMusicSong(SONG_ID, "ua")).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never calls Apple for something that is not a catalogue id or storefront", async () => {
    expect(await getAppleMusicSong("i.PkdJvPXI2AJgm8", "ua")).toEqual({ ok: false, error: "not_found" });
    expect(await getAppleMusicSong(SONG_ID, "UKR")).toEqual({ ok: false, error: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the storefront's catalogue with the developer token", async () => {
    fetchMock.mockResolvedValue(answer(200, { data: [rawSong()] }));
    const result = await getAppleMusicSong(SONG_ID, "ua");
    expect(result.ok && result.value.title).toBe("Never Gonna Give You Up");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.music.apple.com/v1/catalog/ua/songs/${SONG_ID}`);
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
  });

  it("answers a song it just read from memory, unless asked for Apple's current word", async () => {
    fetchMock.mockResolvedValue(answer(200, { data: [rawSong()] }));
    await getAppleMusicSong(SONG_ID, "ua");
    await getAppleMusicSong(SONG_ID, "ua");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(answer(200, { data: [rawSong()] }));
    await getAppleMusicSong(SONG_ID, "ua", { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tells a missing song, Apple's quota and Apple being down apart", async () => {
    fetchMock.mockResolvedValueOnce(answer(404));
    expect(await getAppleMusicSong(SONG_ID, "ua")).toEqual({ ok: false, error: "not_found" });
    fetchMock.mockResolvedValueOnce(answer(200, { data: [] }));
    expect(await getAppleMusicSong(SONG_ID, "ua")).toEqual({ ok: false, error: "not_found" });
    fetchMock.mockResolvedValueOnce(answer(429));
    expect(await getAppleMusicSong(SONG_ID, "ua")).toEqual({ ok: false, error: "rate_limited" });
    fetchMock.mockResolvedValueOnce(answer(500));
    expect(await getAppleMusicSong(SONG_ID, "ua")).toEqual({ ok: false, error: "upstream_unavailable" });
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await getAppleMusicSong(SONG_ID, "ua")).toEqual({ ok: false, error: "upstream_unavailable" });
  });

  it("answers not_configured when the key file cannot be read", async () => {
    env.APPLE_MUSIC_KEY_PATH = join(KEY_DIR, "missing.p8");
    expect(await getAppleMusicSong(SONG_ID, "ua")).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
