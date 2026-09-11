import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const env = {
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "client-secret",
  SPOTIFY_REDIRECT_URI: "https://dating-api.gennety.com/v1/integrations/spotify/callback",
};
vi.mock("../../config.js", () => ({ env }));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const oauth = await import("./spotify-oauth.js");
const { __resetSpotifyState } = await import("./spotify.js");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TRACK_ID = "4uLU6hMCjMI75M1A2tKUQC";
const TEN_MINUTES = 10 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawTrack(): Record<string, unknown> {
  return {
    id: TRACK_ID,
    name: "Never Gonna Give You Up",
    artists: [{ name: "Rick Astley" }],
    album: { name: "Whenever You Need Somebody", images: [] },
    preview_url: null,
    explicit: false,
  };
}

function start(userId = USER, now = Date.now()) {
  const url = new URL(oauth.startTopTracksImport(userId, now));
  return {
    url,
    state: url.searchParams.get("state") ?? "",
    challenge: url.searchParams.get("code_challenge") ?? "",
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  oauth.__resetSpotifyOAuthState();
  __resetSpotifyState();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("startTopTracksImport", () => {
  it("asks Spotify for user-top-read and nothing else, with S256 PKCE", () => {
    const { url, state, challenge } = start();

    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("scope")).toBe("user-top-read");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(env.SPOTIFY_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The secret never travels in a URL a browser sees.
    expect(url.toString()).not.toContain("client-secret");
  });

  it("mints a fresh state every time", () => {
    expect(start().state).not.toBe(start().state);
  });
});

describe("completeTopTracksImport", () => {
  it("treats an unknown state as expired and calls nobody", async () => {
    expect(await oauth.completeTopTracksImport({ state: "forged", code: "c" })).toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads Cancel on Spotify's page as cancelled — and the state is spent", async () => {
    const { state } = start();
    expect(await oauth.completeTopTracksImport({ state, error: "access_denied" })).toBe(
      "cancelled",
    );
    expect(await oauth.completeTopTracksImport({ state, code: "c" })).toBe("expired");
  });

  it("expires an attempt after ten minutes", async () => {
    const t0 = Date.now();
    const { state } = start(USER, t0);
    expect(await oauth.completeTopTracksImport({ state, code: "c" }, t0 + TEN_MINUTES + 1)).toBe(
      "expired",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges the code with the verifier and no secret, reads the top once, keeps it for that user only", async () => {
    const { state, challenge } = start();
    fetchMock
      .mockResolvedValueOnce(
        json(200, { access_token: "user-token", refresh_token: "never-kept", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(json(200, { items: [rawTrack()] }));

    expect(await oauth.completeTopTracksImport({ state, code: "the-code" })).toBe("ok");

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(tokenUrl)).toBe("https://accounts.spotify.com/api/token");
    const form = new URLSearchParams(String(tokenInit?.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe(env.SPOTIFY_REDIRECT_URI);
    expect(form.get("client_id")).toBe("client-id");
    expect(
      createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(challenge);
    expect(form.has("client_secret")).toBe(false);
    expect(JSON.stringify(tokenInit?.headers ?? {})).not.toContain("Basic");

    const [topUrl, topInit] = fetchMock.mock.calls[1] ?? [];
    expect(String(topUrl)).toBe(
      "https://api.spotify.com/v1/me/top/tracks?limit=15&time_range=medium_term",
    );
    expect((topInit?.headers as Record<string, string>).Authorization).toBe("Bearer user-token");

    expect(oauth.peekTopTracksImport(USER)).toEqual([
      expect.objectContaining({ spotifyTrackId: TRACK_ID }),
    ]);
    expect(oauth.peekTopTracksImport(OTHER)).toBeNull();
  });

  it("reports Spotify's development-mode allow-list as not_allowed", async () => {
    const { state } = start();
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "user-token" }))
      .mockResolvedValueOnce(json(403, { error: { status: 403 } }));
    expect(await oauth.completeTopTracksImport({ state, code: "c" })).toBe("not_allowed");
    expect(oauth.peekTopTracksImport(USER)).toBeNull();
  });

  it("reports an empty listening history as empty", async () => {
    const { state } = start();
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "user-token" }))
      .mockResolvedValueOnce(json(200, { items: [] }));
    expect(await oauth.completeTopTracksImport({ state, code: "c" })).toBe("empty");
    expect(oauth.peekTopTracksImport(USER)).toBeNull();
  });

  it("fails closed when Spotify refuses the code, and when the network does", async () => {
    const first = start();
    fetchMock.mockResolvedValueOnce(json(400, { error: "invalid_grant" }));
    expect(await oauth.completeTopTracksImport({ state: first.state, code: "c" })).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = start();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await oauth.completeTopTracksImport({ state: second.state, code: "c" })).toBe(
      "failed",
    );
  });
});

describe("the imported candidates", () => {
  it("are dropped after fifteen minutes and once the person saved", async () => {
    const t0 = Date.now();
    const { state } = start(USER, t0);
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "user-token" }))
      .mockResolvedValueOnce(json(200, { items: [rawTrack()] }));
    await oauth.completeTopTracksImport({ state, code: "c" }, t0);

    expect(oauth.peekTopTracksImport(USER, t0 + 1)).not.toBeNull();
    oauth.clearTopTracksImport(USER);
    expect(oauth.peekTopTracksImport(USER, t0 + 1)).toBeNull();
  });

  it("do not outlive their window", async () => {
    const t0 = Date.now();
    const { state } = start(USER, t0);
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "user-token" }))
      .mockResolvedValueOnce(json(200, { items: [rawTrack()] }));
    await oauth.completeTopTracksImport({ state, code: "c" }, t0);

    expect(oauth.peekTopTracksImport(USER, t0 + FIFTEEN_MINUTES + 1)).toBeNull();
  });
});
