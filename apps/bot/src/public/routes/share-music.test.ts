import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../../config.js", () => ({
  env: { PROFILE_MUSIC_ENABLED: true, JWT_SECRET, BOT_TOKEN: "123456:test-bot-token", SHORT_VIDEO_FETCH_TIMEOUT_MS: 8000 },
}));
const h = vi.hoisted(() => ({ read: vi.fn(), append: vi.fn() }));
vi.mock("../../services/share-music/read.js", () => ({ readSharedMusic: h.read }));
vi.mock("../../services/music/profile-music.js", () => ({ appendProfileMusic: h.append }));
vi.mock("../../services/music/spotify.js", () => ({ searchTracks: vi.fn() }));

const { createShareMusicRouter } = await import("./share-music.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function app() {
  const server = express();
  server.use(express.json());
  server.use("/v1/me/share/music", createShareMusicRouter());
  return server;
}

const auth = () => ({
  Authorization: `Bearer ${jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  })}`,
});

beforeEach(() => {
  h.read.mockReset();
  h.append.mockReset();
});

describe("POST /v1/me/share/music", () => {
  it("needs a login", async () => {
    expect((await request(app()).post("/v1/me/share/music").send({ url: "x" })).status).toBe(401);
  });

  it("400 bad-request without a url, not-music for a link it does not read", async () => {
    expect((await request(app()).post("/v1/me/share/music").set(auth()).send({})).body).toEqual({ error: "bad-request" });
    h.read.mockResolvedValue({ ok: false, error: "not_music" });
    const res = await request(app()).post("/v1/me/share/music").set(auth()).send({ url: "https://example.com" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "not-music" });
  });

  it("answers the read for the caller", async () => {
    h.read.mockResolvedValue({ ok: true, music: { status: "read", tracks: [], selectedCount: 0 } });
    const res = await request(app())
      .post("/v1/me/share/music")
      .set(auth())
      .send({ url: " https://music.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef " });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("read");
    expect(h.read).toHaveBeenCalledWith("https://music.youtube.com/playlist?list=PLxGennetyDemo0123456789abcdef", USER_ID, undefined);
  });
});

describe("POST /v1/me/share/music/add", () => {
  const refs = [{ provider: "spotify", trackId: "0VjIjW4GlUZAMYd2vXMi3b" }];

  it("appends and reports what was skipped", async () => {
    h.append.mockResolvedValue({
      ok: true,
      tracks: [],
      added: 1,
      skipped: { duplicate: 0, notFound: 0, overLimit: 0, failed: 0 },
    });
    const res = await request(app()).post("/v1/me/share/music/add").set(auth()).send({ tracks: refs });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(h.append).toHaveBeenCalledWith(USER_ID, refs);
  });

  it.each([
    ["too_many_tracks", 409],
    ["invalid_tracks", 400],
    ["upstream_unavailable", 502],
    ["rate_limited", 503],
  ])("%s → %i", async (error, status) => {
    h.append.mockResolvedValue({ ok: false, error });
    const res = await request(app()).post("/v1/me/share/music/add").set(auth()).send({ tracks: refs });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error });
  });
});
