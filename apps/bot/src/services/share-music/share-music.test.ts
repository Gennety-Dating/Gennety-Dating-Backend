import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { MusicTrack } from "../music/track.js";

vi.mock("../../config.js", () => ({ env: { SHORT_VIDEO_FETCH_TIMEOUT_MS: 8000 } }));
vi.mock("@gennety/db", () => ({ prisma: {} }));

const { classifyShareMusicUrl, isShareMusicHost } = await import("./links.js");
const {
  findYouTubeAlbumPlaylist,
  parseMusicLdJson,
  parseSoundCloud,
  parseSpotifyEmbed,
  parseYandexMusic,
  parseYouTubeOembed,
  parseYouTubePlaylist,
  splitYouTubeTitle,
} = await import("./parse.js");
const { matchQuery, pickMatch } = await import("./match.js");
const { clearShareMusicCache, readSharedMusic } = await import("./read.js");
const { musicTitleKey } = await import("../music/track.js");
type Deps = import("./read.js").ShareMusicReadDeps;
type Keys = import("../music/profile-music.js").ProfileMusicKeys;

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8");
const USER = "11111111-1111-4111-8111-111111111111";

function spotifyTrack(id: string, title: string, artists: string, cover = `https://i.scdn.co/image/${id}`): MusicTrack {
  return {
    provider: "spotify",
    trackId: id,
    title,
    artists,
    albumName: "Album",
    coverUrl: cover,
    url: `https://open.spotify.com/track/${id}`,
    previewUrl: null,
    explicit: false,
    storefront: null,
  };
}

const noKeys = (): Promise<Keys> => Promise.resolve({ refs: new Set(), titles: new Set(), count: 0 });

/** A deps set whose network is a URL → fixture map; anything else is unreachable. */
type FetchText = NonNullable<Deps["fetchText"]>;
function deps(
  pages: Record<string, string | { body: string; finalUrl: string }>,
  extra: Deps = {},
): Deps & { fetchText: Mock<FetchText> } {
  const fetchText = vi.fn<FetchText>(async (url: string) => {
    const page = pages[url];
    if (page === undefined) return null;
    return typeof page === "string" ? { body: page, finalUrl: url } : page;
  });
  return {
    appleConfigured: () => false,
    spotifyTrack: vi.fn(async () => ({ ok: false as const, error: "not_found" as const })),
    search: vi.fn(async () => ({ ok: true as const, value: [] })),
    keys: noKeys,
    ...extra,
    fetchText,
  };
}

beforeEach(() => clearShareMusicCache());

/* ── links ─────────────────────────────────────────────────────────────── */

describe("classifyShareMusicUrl", () => {
  it.each([
    ["https://music.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef&si=Ab12", "youtube_music", "playlist", "https://music.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef"],
    ["https://music.youtube.com/playlist?list=OLAK5uy_kA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6", "youtube_music", "album", "https://music.youtube.com/playlist?list=OLAK5uy_kA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"],
    ["https://music.youtube.com/watch?v=4NRXx6U8ABQ&list=RDAMVM4NRXx6U8ABQ", "youtube_music", "track", "https://music.youtube.com/watch?v=4NRXx6U8ABQ"],
    ["https://music.youtube.com/browse/MPREb_aBcDeFgHiJk", "youtube_music", "album", "https://music.youtube.com/browse/MPREb_aBcDeFgHiJk"],
    ["https://www.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef", "youtube", "playlist", "https://www.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef"],
    ["https://m.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef", "youtube", "playlist", "https://www.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef"],
    ["https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n?si=8f2", "spotify", "playlist", "https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n"],
    ["https://open.spotify.com/intl-de/album/4yP0hdKOZPNshxUOjY0cZj", "spotify", "album", "https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj"],
    ["https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b?si=x", "spotify", "track", "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"],
    ["https://music.apple.com/us/playlist/chill-indie/pl.f4d106fed2bd41149aaacabb233eb5eb", "apple_music", "playlist", "https://music.apple.com/us/playlist/pl.f4d106fed2bd41149aaacabb233eb5eb"],
    ["https://music.apple.com/ua/album/punisher/1503441900", "apple_music", "album", "https://music.apple.com/ua/album/1503441900"],
    ["https://music.apple.com/ua/album/punisher/1503441900?i=1503441917", "apple_music", "track", "https://music.apple.com/ua/song/1503441917"],
    ["https://music.yandex.ru/album/4766", "yandex_music", "album", "https://music.yandex.ru/album/4766"],
    ["https://music.yandex.com/album/4766/track/38633?utm_source=web", "yandex_music", "track", "https://music.yandex.ru/album/4766/track/38633"],
    ["https://music.yandex.ru/users/gleb.music/playlists/1003", "yandex_music", "playlist", "https://music.yandex.ru/users/gleb.music/playlists/1003"],
    ["https://music.yandex.ru/playlists/lk.0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "yandex_music", "playlist", "https://music.yandex.ru/playlists/lk.0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"],
    ["https://soundcloud.com/djgleb/sets/summer-sets?si=1", "soundcloud", "playlist", "https://soundcloud.com/djgleb/sets/summer-sets"],
    ["https://m.soundcloud.com/djgleb/sunset-groove", "soundcloud", "track", "https://soundcloud.com/djgleb/sunset-groove"],
  ])("%s", (raw, source, kind, url) => {
    expect(classifyShareMusicUrl(raw)).toMatchObject({ source, kind, url });
  });

  it("keeps the Apple storefront and the Yandex owner", () => {
    expect(classifyShareMusicUrl("https://music.apple.com/ua/album/x/1503441900")?.storefront).toBe("ua");
    expect(classifyShareMusicUrl("https://music.yandex.ru/users/gleb.music/playlists/1003")?.owner).toBe("gleb.music");
  });

  it("reads short links as stubs to resolve", () => {
    expect(classifyShareMusicUrl("https://spotify.link/AbC123xyz")).toMatchObject({ source: "spotify", id: null });
    expect(classifyShareMusicUrl("https://on.soundcloud.com/AbC123")).toMatchObject({ source: "soundcloud", id: null });
  });

  it.each([
    "https://www.youtube.com/watch?v=4NRXx6U8ABQ", // a video — the short-video read's
    "https://youtu.be/4NRXx6U8ABQ",
    "https://www.youtube.com/shorts/abcDEF12345",
    "https://music.youtube.com/channel/UC0WP5P-ufpRfjbNrmOWwLBQ",
    "https://music.youtube.com.evil.tld/playlist?list=PLxGennetyDemo0123456789abcdef",
    "https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5",
    "https://open.spotify.com/artist/1Xyo4u8uXC1ZmMpatF05PJ",
    "https://music.apple.com/us/artist/phoebe-bridgers/1012882072",
    "https://music.yandex.ru/artist/41191",
    "https://soundcloud.com/discover",
    "https://soundcloud.com/djgleb/likes",
    "https://user:pass@open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n",
    "https://open.spotify.com:8443/playlist/3cEYpjA9oz9GiPac4AsH4n",
    "ftp://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n",
    "not a url",
  ])("not music: %s", (raw) => {
    expect(classifyShareMusicUrl(raw)).toBeNull();
  });

  it("allows only music hosts to be fetched", () => {
    for (const host of ["www.youtube.com", "music.youtube.com", "open.spotify.com", "spotify.link", "music.apple.com", "music.yandex.ru", "api.music.yandex.net", "soundcloud.com", "on.soundcloud.com"]) {
      expect(isShareMusicHost(host), host).toBe(true);
    }
    for (const host of ["api.music.apple.com", "evil-youtube.com", "spotify.com.evil.tld", "music.yandex.evil", "169.254.169.254", "localhost"]) {
      expect(isShareMusicHost(host), host).toBe(false);
    }
  });
});

/* ── parsers, on saved responses ───────────────────────────────────────── */

describe("provider parsers", () => {
  it("Spotify embed: a playlist's rows with their track ids, episodes counted out", () => {
    const page = parseSpotifyEmbed(fixture("spotify-embed-playlist.html"))!;
    expect(page).toMatchObject({ title: "Late Night Drive", author: "gleb", total: 6, unreadable: 1 });
    expect(page.coverUrl).toBe("https://image-cdn-ak.spotifycdn.com/image/ab67706c0000da84late");
    expect(page.tracks).toHaveLength(5);
    expect(page.tracks[1]).toEqual({
      title: "Get Lucky (feat. Pharrell Williams & Nile Rodgers)",
      artists: "Daft Punk, Pharrell Williams, Nile Rodgers",
      albumName: null,
      coverUrl: null,
      sourceUrl: "https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof",
      ref: { provider: "spotify", trackId: "2Foc5Q5nqNiosCNqttzHof" },
    });
  });

  it("Spotify embed: an album's rows share its cover and name", () => {
    const page = parseSpotifyEmbed(fixture("spotify-embed-album.html"))!;
    expect(page.tracks.map((t) => [t.title, t.albumName, t.coverUrl])).toEqual([
      ["Blinding Lights", "After Hours", "https://i.scdn.co/image/ab67616d00001e02afterhours"],
      ["Save Your Tears", "After Hours", "https://i.scdn.co/image/ab67616d00001e02afterhours"],
      ["In Your Eyes", "After Hours", "https://i.scdn.co/image/ab67616d00001e02afterhours"],
    ]);
  });

  it("YouTube playlist page: songs and artists out of upload titles, deleted rows counted out", () => {
    const page = parseYouTubePlaylist(fixture("youtube-playlist.html"))!;
    expect(page).toMatchObject({ title: "Night Drive Mix", author: "gleb", total: 142, unreadable: 1 });
    expect(page.tracks.map((t) => [t.title, t.artists])).toEqual([
      ["Blinding Lights", "The Weeknd"],
      ["Get Lucky", "Daft Punk, Pharrell Williams, Nile Rodgers"],
      ["Hello", "Adele"],
      ["late night demo", "unknown kid"],
      ["Blinding Lights", "The Weeknd"],
    ]);
    expect(page.tracks[0]!.coverUrl).toBe("https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg");
    expect(page.tracks[0]!.sourceUrl).toBe("https://music.youtube.com/watch?v=4NRXx6U8ABQ");
  });

  it("YouTube page without data is nothing", () => {
    expect(parseYouTubePlaylist("<html><body>consent</body></html>")).toBeNull();
  });

  it("YouTube oEmbed: one YouTube Music track", () => {
    const page = parseYouTubeOembed(fixture("youtube-oembed.json"), "4NRXx6U8ABQ")!;
    expect(page.tracks).toEqual([
      expect.objectContaining({ title: "Blinding Lights", artists: "The Weeknd", ref: null }),
    ]);
  });

  it("YouTube Music album page names its OLAK playlist", () => {
    expect(findYouTubeAlbumPlaylist(fixture("youtube-music-album.html"))).toBe(
      "OLAK5uy_kA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
    );
  });

  it("schema.org MusicPlaylist (an Apple Music page)", () => {
    const page = parseMusicLdJson(fixture("apple-music-playlist.html"))!;
    expect(page).toMatchObject({ title: "Chill Indie", author: "Apple Music Indie", total: 100, unreadable: 1 });
    expect(page.tracks.map((t) => [t.title, t.artists, t.albumName])).toEqual([
      ["Motion Sickness", "Phoebe Bridgers", "Stranger in the Alps"],
      ["Kyoto", "Phoebe Bridgers", null],
    ]);
  });

  it("Yandex Music album: versions kept, unavailable tracks counted out", () => {
    const page = parseYandexMusic(fixture("yandex-album.json"))!;
    expect(page).toMatchObject({ title: "Группа крови", author: "Кино", total: 3, unreadable: 1 });
    expect(page.tracks[1]).toMatchObject({
      title: "Закрой за мной дверь, я ухожу (Remastered 2019)",
      artists: "Кино",
      coverUrl: "https://avatars.yandex.net/get-music-content/49876/2d2f1e6a.a.4766-1/300x300",
      sourceUrl: "https://music.yandex.ru/album/4766/track/38634",
    });
  });

  it("Yandex Music playlist: id-only rows counted out", () => {
    const page = parseYandexMusic(fixture("yandex-playlist.json"))!;
    expect(page).toMatchObject({ title: "Вечер", author: "Gleb", total: 4, unreadable: 1 });
    expect(page.tracks.map((t) => t.title)).toEqual(["Мне нравится", "Believer", "Believer"]);
    // A track with no cover of its own takes the playlist's.
    expect(page.tracks[1]!.coverUrl).toBe("https://avatars.yandex.net/get-music-user-playlist/1/r/300x300");
  });

  it("SoundCloud set: full tracks read, stubs counted, never guessed", () => {
    const page = parseSoundCloud(fixture("soundcloud-set.html"))!;
    expect(page).toMatchObject({ title: "Summer Sets", author: "djgleb", total: 5, unreadable: 3 });
    expect(page.tracks).toEqual([
      expect.objectContaining({ title: "Sunset Groove", artists: "djgleb", coverUrl: "https://i1.sndcdn.com/artworks-1abc-t300x300.jpg" }),
      expect.objectContaining({ title: "Ocean Drive", artists: "Duke Dumont", coverUrl: "https://i1.sndcdn.com/artworks-setcover-t300x300.jpg" }),
    ]);
  });

  it.each([
    ["Blinding Lights", "The Weeknd - Topic", "Blinding Lights", "The Weeknd"],
    ["Adele - Hello (Official Music Video)", "AdeleVEVO", "Hello", "Adele"],
    ["Земфира — Хочешь? [Official Video]", "Zemfira", "Хочешь?", "Земфира"],
    ["Hello | Live at the Church Studios", "Adele", "Hello", "Adele"],
    ["late night demo", "unknown kid", "late night demo", "unknown kid"],
  ])("splitYouTubeTitle(%s, %s)", (title, channel, song, artists) => {
    expect(splitYouTubeTitle(title, channel)).toEqual({ title: song, artists });
  });
});

/* ── matching ──────────────────────────────────────────────────────────── */

describe("pickMatch", () => {
  const lucky = spotifyTrack("2Foc5Q5nqNiosCNqttzHof", "Get Lucky (feat. Pharrell Williams & Nile Rodgers)", "Daft Punk, Pharrell Williams, Nile Rodgers");

  it("takes the same song by a shared artist, whatever the version note", () => {
    expect(pickMatch("Get Lucky", "Daft Punk", [lucky])).toBe(lucky);
    const remaster = spotifyTrack("3n3Ppam7vgaVa1iaRUc9Lp", "Mr. Brightside - Remastered 2015", "The Killers");
    expect(pickMatch("Mr Brightside", "the killers", [remaster])).toBe(remaster);
  });

  it("refuses another song, another artist, a remix, or a source with no artist", () => {
    const cover = spotifyTrack("4uLU6hMCjMI75M1A2tKUQC", "Get Lucky", "Some Cover Band");
    const remix = spotifyTrack("7GhIk7Il098yCjg4BQjzvb", "Get Lucky Remix", "Daft Punk");
    expect(pickMatch("Get Lucky", "Daft Punk", [cover, remix])).toBeNull();
    expect(pickMatch("Get Lucky", "", [lucky])).toBeNull();
  });

  it("searches by the primary artist and the core title", () => {
    expect(matchQuery("Get Lucky (Radio Edit)", "Daft Punk, Pharrell Williams")).toBe("Daft Punk Get Lucky");
  });

  it("one key for one song across providers", () => {
    expect(musicTitleKey("Get Lucky (feat. Pharrell Williams)", "Daft Punk & Pharrell Williams")).toBe(
      musicTitleKey("Get Lucky - Radio Edit", "Pharrell Williams, Daft Punk"),
    );
    expect(musicTitleKey("Ёлка", "Земфира")).toBe(musicTitleKey("Елка", "земфира"));
  });
});

/* ── the whole read ────────────────────────────────────────────────────── */

const YTM_PLAYLIST = "https://music.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef";
const YT_PAGE = "https://www.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef";

const CATALOGUE: Record<string, MusicTrack[]> = {
  "The Weeknd Blinding Lights": [spotifyTrack("0VjIjW4GlUZAMYd2vXMi3b", "Blinding Lights", "The Weeknd")],
  "Daft Punk Get Lucky": [
    spotifyTrack("2Foc5Q5nqNiosCNqttzHof", "Get Lucky (feat. Pharrell Williams & Nile Rodgers)", "Daft Punk, Pharrell Williams, Nile Rodgers"),
  ],
  "Adele Hello": [spotifyTrack("4sPmO7WMQUAf45kwMOtONw", "Hello", "Adele")],
};
const search = vi.fn(async (query: string) => ({ ok: true as const, value: CATALOGUE[query] ?? [] }));

describe("readSharedMusic — YouTube Music playlist (the founder's link)", () => {
  beforeEach(() => search.mockClear());

  it("expands into one card per song, all matched ones ticked", async () => {
    const d = deps({ [YT_PAGE]: fixture("youtube-playlist.html") }, { search });
    const result = await readSharedMusic(`${YTM_PLAYLIST}&si=abc`, USER, d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const music = result.music;
    expect(music).toMatchObject({
      status: "read",
      source: "youtube_music",
      kind: "playlist",
      url: YTM_PLAYLIST,
      title: "Night Drive Mix",
      total: 142,
      truncated: true, // 142 on YouTube, the first page here
      partial: true, // a deleted video was listed
      slotsLeft: 30,
      selectedCount: 3,
    });
    expect(music.tracks.map((t) => [t.title, t.state, t.selected, t.match?.trackId ?? null])).toEqual([
      ["Blinding Lights", "new", true, "0VjIjW4GlUZAMYd2vXMi3b"],
      ["Get Lucky (feat. Pharrell Williams & Nile Rodgers)", "new", true, "2Foc5Q5nqNiosCNqttzHof"],
      ["Hello", "new", true, "4sPmO7WMQUAf45kwMOtONw"],
      ["late night demo", "not_found", false, null],
    ]);
    // The card shows what will be pinned — Spotify's cover — and links back to the source.
    expect(music.tracks[0]).toMatchObject({
      coverUrl: "https://i.scdn.co/image/0VjIjW4GlUZAMYd2vXMi3b",
      sourceUrl: "https://music.youtube.com/watch?v=4NRXx6U8ABQ",
      match: { provider: "spotify", storefront: null, url: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b" },
    });
    // The lyric-video duplicate of «Blinding Lights» was folded before any search.
    expect(search).toHaveBeenCalledTimes(4);
    expect(d.fetchText).toHaveBeenCalledWith(
      YT_PAGE,
      expect.objectContaining({ maxBytes: 4_000_000, headers: expect.objectContaining({ Cookie: "SOCS=CAI" }) }),
    );
  });

  it("marks what is already on the profile and ticks only as many as there is room for", async () => {
    const keys = async (): Promise<Keys> => ({
      refs: new Set(["spotify:0VjIjW4GlUZAMYd2vXMi3b"]),
      titles: new Set(),
      count: 29,
    });
    const result = await readSharedMusic(YTM_PLAYLIST, USER, deps({ [YT_PAGE]: fixture("youtube-playlist.html") }, { search, keys }));
    if (!result.ok) throw new Error("expected a read");
    expect(result.music.slotsLeft).toBe(1);
    expect(result.music.selectedCount).toBe(1);
    expect(result.music.tracks.map((t) => [t.state, t.selected])).toEqual([
      ["added", false],
      ["new", true],
      ["new", false],
      ["not_found", false],
    ]);
  });

  it("is cached per URL but the ticks are per person", async () => {
    const first = deps({ [YT_PAGE]: fixture("youtube-playlist.html") }, { search });
    await readSharedMusic(YTM_PLAYLIST, USER, first);
    const second = deps({}, {
      search,
      keys: async () => ({ refs: new Set(), titles: new Set([musicTitleKey("Hello", "Adele")]), count: 1 }),
    });
    const result = await readSharedMusic(YTM_PLAYLIST, USER, second);
    expect(second.fetchText).not.toHaveBeenCalled();
    if (!result.ok) throw new Error("expected a read");
    expect(result.music.tracks[2]!.state).toBe("added");
  });

  it("stops searching at Spotify's quota, keeps the cards, is partial and not cached", async () => {
    const limited = vi.fn(async () => ({ ok: false as const, error: "rate_limited" as const }));
    const d = deps({ [YT_PAGE]: fixture("youtube-playlist.html") }, { search: limited });
    const result = await readSharedMusic(YTM_PLAYLIST, USER, d);
    if (!result.ok) throw new Error("expected a read");
    expect(result.music.partial).toBe(true);
    expect(result.music.selectedCount).toBe(0);
    expect(result.music.tracks.every((t) => t.state === "not_found")).toBe(true);
    expect(limited.mock.calls.length).toBeLessThanOrEqual(4);
    await readSharedMusic(YTM_PLAYLIST, USER, d);
    expect(d.fetchText).toHaveBeenCalledTimes(2);
  });

  it("leaves the rest unmatched once the time budget is spent", async () => {
    let clock = 0;
    const slow = vi.fn(async (query: string) => {
      clock += 20_000; // the first search alone eats the budget
      return { ok: true as const, value: CATALOGUE[query] ?? [] };
    });
    const result = await readSharedMusic(
      YTM_PLAYLIST,
      USER,
      deps({ [YT_PAGE]: fixture("youtube-playlist.html") }, { search: slow, now: () => clock }),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music.partial).toBe(true);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("a page YouTube would not serve is closed, not an error", async () => {
    const result = await readSharedMusic(YTM_PLAYLIST, USER, deps({ [YT_PAGE]: "<html>consent.youtube.com</html>" }));
    expect(result).toEqual({
      ok: true,
      music: expect.objectContaining({ status: "closed", tracks: [], selectedCount: 0, source: "youtube_music" }),
    });
  });
});

describe("readSharedMusic — other sources", () => {
  it("YouTube Music album page → its OLAK playlist on youtube.com", async () => {
    const result = await readSharedMusic(
      "https://music.youtube.com/browse/MPREb_aBcDeFgHiJk",
      USER,
      deps(
        {
          "https://music.youtube.com/browse/MPREb_aBcDeFgHiJk": fixture("youtube-music-album.html"),
          "https://www.youtube.com/playlist?list=OLAK5uy_kA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6": fixture("youtube-playlist.html"),
        },
        { search },
      ),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music).toMatchObject({ status: "read", kind: "album", selectedCount: 3 });
  });

  it("a YouTube Music track → one card", async () => {
    const result = await readSharedMusic(
      "https://music.youtube.com/watch?v=4NRXx6U8ABQ",
      USER,
      deps(
        {
          "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D4NRXx6U8ABQ":
            fixture("youtube-oembed.json"),
        },
        { search },
      ),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music).toMatchObject({ kind: "track", selectedCount: 1 });
    expect(result.music.tracks).toHaveLength(1);
  });

  it("Spotify playlist: ids straight from the embed, covers fetched, no search", async () => {
    const searchSpy = vi.fn();
    const covers = vi.fn(async (id: string) => ({ ok: true as const, value: spotifyTrack(id, `Spotify ${id}`, "Spotify Artist") }));
    const d = deps(
      { "https://open.spotify.com/embed/playlist/3cEYpjA9oz9GiPac4AsH4n": fixture("spotify-embed-playlist.html") },
      { search: searchSpy, spotifyTrack: covers },
    );
    const result = await readSharedMusic("https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n?si=1", USER, d);
    if (!result.ok) throw new Error("expected a read");
    // Five track rows; the second «Never Gonna Give You Up» is the same song.
    expect(result.music.tracks).toHaveLength(4);
    expect(result.music).toMatchObject({ source: "spotify", partial: true, selectedCount: 4, truncated: false });
    expect(result.music.tracks.every((t) => t.match?.provider === "spotify" && t.coverUrl?.startsWith("https://i.scdn.co/"))).toBe(true);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(covers).toHaveBeenCalledTimes(4);
  });

  it("Spotify playlist still reads when Spotify's API is out — the ids need no lookup", async () => {
    const down = vi.fn(async () => ({ ok: false as const, error: "upstream_unavailable" as const }));
    const result = await readSharedMusic(
      "https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n",
      USER,
      deps({ "https://open.spotify.com/embed/playlist/3cEYpjA9oz9GiPac4AsH4n": fixture("spotify-embed-playlist.html") }, { spotifyTrack: down }),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music.selectedCount).toBe(4);
    expect(result.music.tracks[0]).toMatchObject({ title: "Blinding Lights", coverUrl: null, match: { trackId: "0VjIjW4GlUZAMYd2vXMi3b" } });
  });

  it("Spotify album: the album's cover is enough — no per-track call", async () => {
    const covers = vi.fn();
    const result = await readSharedMusic(
      "https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj",
      USER,
      deps({ "https://open.spotify.com/embed/album/4yP0hdKOZPNshxUOjY0cZj": fixture("spotify-embed-album.html") }, { spotifyTrack: covers }),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music).toMatchObject({ kind: "album", selectedCount: 3, partial: false });
    expect(covers).not.toHaveBeenCalled();
  });

  it("a Spotify short link is followed to its playlist", async () => {
    const result = await readSharedMusic(
      "https://spotify.link/AbC123xyz",
      USER,
      deps({
        "https://spotify.link/AbC123xyz": {
          body: "<html></html>",
          finalUrl: "https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n?si=x",
        },
        "https://open.spotify.com/embed/playlist/3cEYpjA9oz9GiPac4AsH4n": fixture("spotify-embed-playlist.html"),
      }),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music).toMatchObject({ url: "https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n", status: "read" });
  });

  it("Apple Music with its key: catalogue songs, kept as Apple Music, no search", async () => {
    const { mapAppleMusicSong } = await import("../music/apple-music.js");
    const api = JSON.parse(fixture("apple-music-api-playlist.json")) as {
      data: [{ relationships: { tracks: { data: unknown[] } } }];
    };
    const songs = api.data[0].relationships.tracks.data
      .map((row) => mapAppleMusicSong(row, "us"))
      .filter((song) => song !== null);
    const appleCollection = vi.fn(async () => ({
      ok: true as const,
      value: { name: "Chill Indie", author: "Apple Music Indie", coverUrl: null, total: null, songs, more: true, skipped: 1 },
    }));
    const searchSpy = vi.fn();
    const result = await readSharedMusic(
      "https://music.apple.com/us/playlist/chill-indie/pl.f4d106fed2bd41149aaacabb233eb5eb",
      USER,
      deps({}, { appleConfigured: () => true, appleCollection, search: searchSpy }),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(appleCollection).toHaveBeenCalledWith("playlists", "pl.f4d106fed2bd41149aaacabb233eb5eb", "us");
    expect(result.music).toMatchObject({ truncated: true, selectedCount: 2 });
    expect(result.music.tracks[0]!.match).toEqual({
      provider: "apple_music",
      trackId: "1440857781",
      storefront: "us",
      url: "https://music.apple.com/us/album/x/1?i=1440857781",
    });
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("Apple Music without a key: the page's schema.org list, matched in Spotify", async () => {
    const found = vi.fn(async (query: string) => ({
      ok: true as const,
      value: query === "Phoebe Bridgers Kyoto" ? [spotifyTrack("1aaaaaaaaaaaaaaaaaaaaa", "Kyoto", "Phoebe Bridgers")] : [],
    }));
    const result = await readSharedMusic(
      "https://music.apple.com/us/playlist/chill-indie/pl.f4d106fed2bd41149aaacabb233eb5eb",
      USER,
      deps({ "https://music.apple.com/us/playlist/pl.f4d106fed2bd41149aaacabb233eb5eb": fixture("apple-music-playlist.html") }, { search: found }),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music.tracks.map((t) => t.state)).toEqual(["not_found", "new"]);
  });

  it("Yandex Music album through the public JSON", async () => {
    const found = vi.fn(async (query: string) => ({
      ok: true as const,
      value: query === "Кино Группа крови" ? [spotifyTrack("2bbbbbbbbbbbbbbbbbbbbb", "Группа крови", "Кино")] : [],
    }));
    const result = await readSharedMusic(
      "https://music.yandex.ru/album/4766",
      USER,
      deps({ "https://api.music.yandex.net/albums/4766/with-tracks": fixture("yandex-album.json") }, { search: found }),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music).toMatchObject({ title: "Группа крови", partial: true, selectedCount: 1 });
    expect(result.music.tracks.map((t) => t.state)).toEqual(["new", "not_found"]);
  });

  it("Yandex Music classic playlist uses the owner's path", async () => {
    const d = deps({ "https://api.music.yandex.net/users/gleb.music/playlists/1003": fixture("yandex-playlist.json") });
    const result = await readSharedMusic("https://music.yandex.ru/users/gleb.music/playlists/1003", USER, d);
    if (!result.ok) throw new Error("expected a read");
    expect(result.music.tracks.map((t) => t.title)).toEqual(["Мне нравится", "Believer"]);
  });

  it("SoundCloud set: what the page describes, partial for the rest", async () => {
    const result = await readSharedMusic(
      "https://soundcloud.com/djgleb/sets/summer-sets",
      USER,
      deps({ "https://soundcloud.com/djgleb/sets/summer-sets": fixture("soundcloud-set.html") }),
    );
    if (!result.ok) throw new Error("expected a read");
    expect(result.music).toMatchObject({ status: "read", total: 5, partial: true });
    expect(result.music.tracks).toHaveLength(2);
  });

  it("a link that is not music is not_music", async () => {
    expect(await readSharedMusic("https://www.youtube.com/watch?v=4NRXx6U8ABQ", USER, deps({}))).toEqual({
      ok: false,
      error: "not_music",
    });
  });
});
