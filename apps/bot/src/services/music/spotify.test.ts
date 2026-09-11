import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const env = { SPOTIFY_CLIENT_ID: "client-id", SPOTIFY_CLIENT_SECRET: "client-secret" };
vi.mock("../../config.js", () => ({ env }));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const { mapSpotifyTrack, searchTracks, getTrack, __resetSpotifyState, SPOTIFY_SEARCH_LIMIT } =
  await import("./spotify.js");

const TRACK_ID = "4uLU6hMCjMI75M1A2tKUQC";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function token(value = "app-token"): Response {
  return json(200, { access_token: value, token_type: "Bearer", expires_in: 3600 });
}

function rawTrack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TRACK_ID,
    name: "Never Gonna Give You Up",
    artists: [{ name: "Rick Astley" }],
    album: {
      name: "Whenever You Need Somebody",
      images: [
        { url: "https://i.scdn.co/image/640", width: 640, height: 640 },
        { url: "https://i.scdn.co/image/300", width: 300, height: 300 },
        { url: "https://i.scdn.co/image/64", width: 64, height: 64 },
      ],
    },
    preview_url: null,
    explicit: false,
    external_urls: { spotify: "https://evil.example/track" },
    ...overrides,
  };
}

function urlOf(call: number): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

function headersOf(call: number): Record<string, string> {
  return (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  fetchMock.mockReset();
  __resetSpotifyState();
  env.SPOTIFY_CLIENT_ID = "client-id";
  env.SPOTIFY_CLIENT_SECRET = "client-secret";
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("mapSpotifyTrack", () => {
  it("keeps Spotify's facts and builds the link itself", () => {
    expect(mapSpotifyTrack(rawTrack())).toEqual({
      spotifyTrackId: TRACK_ID,
      title: "Never Gonna Give You Up",
      artists: "Rick Astley",
      albumName: "Whenever You Need Somebody",
      coverUrl: "https://i.scdn.co/image/300",
      spotifyUrl: `https://open.spotify.com/track/${TRACK_ID}`,
      previewUrl: null,
      explicit: false,
    });
  });

  it("joins several artists in Spotify's order", () => {
    const mapped = mapSpotifyTrack(
      rawTrack({ artists: [{ name: "Daft Punk" }, { name: "Pharrell Williams" }] }),
    );
    expect(mapped?.artists).toBe("Daft Punk, Pharrell Williams");
  });

  it("falls back to the largest cover when none is big enough", () => {
    const mapped = mapSpotifyTrack(
      rawTrack({
        album: {
          name: "A",
          images: [
            { url: "https://i.scdn.co/image/64", width: 64 },
            { url: "https://i.scdn.co/image/200", width: 200 },
          ],
        },
      }),
    );
    expect(mapped?.coverUrl).toBe("https://i.scdn.co/image/200");
  });

  it("refuses what cannot sit on a profile", () => {
    expect(mapSpotifyTrack(rawTrack({ is_local: true }))).toBeNull();
    expect(mapSpotifyTrack(rawTrack({ id: "not-an-id" }))).toBeNull();
    expect(mapSpotifyTrack(rawTrack({ artists: [] }))).toBeNull();
    expect(mapSpotifyTrack(rawTrack({ name: "  " }))).toBeNull();
    expect(mapSpotifyTrack(null)).toBeNull();
  });

  it("drops a preview or a cover that is not https", () => {
    const mapped = mapSpotifyTrack(
      rawTrack({
        preview_url: "http://p.scdn.co/preview",
        album: { name: "A", images: [{ url: "javascript:alert(1)", width: 300 }] },
      }),
    );
    expect(mapped?.previewUrl).toBeNull();
    expect(mapped?.coverUrl).toBeNull();
  });
});

describe("searchTracks", () => {
  it("answers not_configured without calling Spotify", async () => {
    env.SPOTIFY_CLIENT_SECRET = "";
    expect(await searchTracks("rick")).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints the app token with the secret, server-side, and asks for the dev-mode cap", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(200, { tracks: { items: [rawTrack()] } }));

    const result = await searchTracks("never gonna");

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ spotifyTrackId: TRACK_ID })],
    });
    expect(urlOf(0)).toBe("https://accounts.spotify.com/api/token");
    expect(headersOf(0).Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toBe("grant_type=client_credentials");
    const searchUrl = new URL(urlOf(1));
    expect(searchUrl.pathname).toBe("/v1/search");
    expect(searchUrl.searchParams.get("type")).toBe("track");
    expect(searchUrl.searchParams.get("limit")).toBe(String(SPOTIFY_SEARCH_LIMIT));
    expect(headersOf(1).Authorization).toBe("Bearer app-token");
  });

  it("reuses one token and answers a repeated query from memory", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(200, { tracks: { items: [rawTrack()] } }))
      .mockResolvedValueOnce(json(200, { tracks: { items: [] } }));

    await searchTracks("rick");
    await searchTracks("  RICK ");
    await searchTracks("astley");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOf(2)).toContain("q=astley");
  });

  it("re-mints once when Spotify drops the token early", async () => {
    fetchMock
      .mockResolvedValueOnce(token("old"))
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(token("new"))
      .mockResolvedValueOnce(json(200, { tracks: { items: [] } }));

    expect(await searchTracks("rick")).toEqual({ ok: true, value: [] });
    expect(headersOf(3).Authorization).toBe("Bearer new");
  });

  it("tells Spotify's quota apart from Spotify being down", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json(429, {}));
    expect(await searchTracks("a1")).toEqual({ ok: false, error: "rate_limited" });

    fetchMock.mockResolvedValueOnce(json(503, {}));
    expect(await searchTracks("a2")).toEqual({ ok: false, error: "upstream_unavailable" });

    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await searchTracks("a3")).toEqual({ ok: false, error: "upstream_unavailable" });
  });
});

describe("getTrack", () => {
  it("never calls Spotify for something that is not a track id", async () => {
    expect(await getTrack("../../me")).toEqual({ ok: false, error: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads not_found from both of Spotify's ways of saying it", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(404, {}))
      .mockResolvedValueOnce(json(400, {}));

    expect(await getTrack(TRACK_ID)).toEqual({ ok: false, error: "not_found" });
    expect(await getTrack(TRACK_ID)).toEqual({ ok: false, error: "not_found" });
  });

  it("answers a track it just saw from memory, unless asked for Spotify's current word", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(200, { tracks: { items: [rawTrack()] } }));
    await searchTracks("rick");

    expect(await getTrack(TRACK_ID)).toEqual({
      ok: true,
      value: expect.objectContaining({ title: "Never Gonna Give You Up" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(json(200, rawTrack({ name: "Renamed" })));
    expect(await getTrack(TRACK_ID, { fresh: true })).toEqual({
      ok: true,
      value: expect.objectContaining({ title: "Renamed" }),
    });
    expect(urlOf(2)).toBe(`https://api.spotify.com/v1/tracks/${TRACK_ID}`);
  });
});
