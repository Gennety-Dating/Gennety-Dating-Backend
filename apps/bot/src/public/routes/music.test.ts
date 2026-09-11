import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TRACK_ID = "4uLU6hMCjMI75M1A2tKUQC";

const env = { PROFILE_MUSIC_ENABLED: true, JWT_SECRET, BOT_TOKEN: "123456:test-bot-token" };
vi.mock("../../config.js", () => ({ env }));

const h = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn(), search: vi.fn() }));
vi.mock("../../services/music/profile-music.js", () => ({
  listProfileMusic: h.list,
  setProfileMusic: h.set,
}));
vi.mock("../../services/music/spotify.js", () => ({ searchTracks: h.search }));

const { createProfileMusicRouter, createMusicSearchRouter } = await import("./music.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

const TRACK = {
  spotifyTrackId: TRACK_ID,
  title: "Never Gonna Give You Up",
  artists: "Rick Astley",
  albumName: "Whenever You Need Somebody",
  coverUrl: "https://i.scdn.co/image/300",
  spotifyUrl: `https://open.spotify.com/track/${TRACK_ID}`,
  previewUrl: null,
  explicit: false,
};

/** Mirrors the gate in server.ts, so the 404-before-auth contract is tested here. */
function gated(router: Router) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!env.PROFILE_MUSIC_ENABLED) {
      res.status(404).json({ error: "profile-music-disabled" });
      return;
    }
    router(req, res, next);
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/music", gated(createProfileMusicRouter()));
  app.use("/v1/music", gated(createMusicSearchRouter()));
  return app;
}

function auth(): { Authorization: string } {
  const token = jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  env.PROFILE_MUSIC_ENABLED = true;
  h.list.mockResolvedValue([TRACK]);
  h.set.mockResolvedValue({ ok: true, tracks: [TRACK] });
  h.search.mockResolvedValue({ ok: true, value: [TRACK] });
});

describe("the feature gate", () => {
  it("answers 404 before auth while the feature is off", async () => {
    env.PROFILE_MUSIC_ENABLED = false;
    expect((await request(buildApp()).get("/v1/me/music")).status).toBe(404);
    expect((await request(buildApp()).get("/v1/music/search?q=rick")).status).toBe(404);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("needs a JWT", async () => {
    expect((await request(buildApp()).get("/v1/me/music")).status).toBe(401);
    expect((await request(buildApp()).get("/v1/music/search?q=rick")).status).toBe(401);
  });
});

describe("GET/PUT /v1/me/music", () => {
  it("returns the caller's tracks", async () => {
    const res = await request(buildApp()).get("/v1/me/music").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tracks: [TRACK] });
    expect(h.list).toHaveBeenCalledWith(USER_ID);
  });

  it("hands the ids to the service and returns the set as saved", async () => {
    const res = await request(buildApp())
      .put("/v1/me/music")
      .set(auth())
      .send({ trackIds: [TRACK_ID] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tracks: [TRACK] });
    expect(h.set).toHaveBeenCalledWith(USER_ID, [TRACK_ID]);
  });

  it.each([
    ["invalid_track_ids", 400],
    ["too_many_tracks", 400],
    ["duplicate_tracks", 400],
    ["track_not_found", 422],
    ["upstream_unavailable", 502],
    ["rate_limited", 503],
    ["not_configured", 503],
  ])("maps %s to %i", async (error, status) => {
    h.set.mockResolvedValue({ ok: false, error });
    const res = await request(buildApp())
      .put("/v1/me/music")
      .set(auth())
      .send({ trackIds: [TRACK_ID] });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error });
  });
});

describe("GET /v1/music/search", () => {
  it("refuses a query too short or too long to be worth Spotify's quota", async () => {
    expect((await request(buildApp()).get("/v1/music/search?q=a").set(auth())).status).toBe(400);
    const long = "x".repeat(101);
    expect((await request(buildApp()).get(`/v1/music/search?q=${long}`).set(auth())).status).toBe(
      400,
    );
    expect(h.search).not.toHaveBeenCalled();
  });

  it("returns Spotify's matches", async () => {
    const res = await request(buildApp()).get("/v1/music/search?q=%20rick%20").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tracks: [TRACK] });
    expect(h.search).toHaveBeenCalledWith("rick");
  });

  it("never answers Spotify's quota with our own 429", async () => {
    h.search.mockResolvedValue({ ok: false, error: "rate_limited" });
    const res = await request(buildApp()).get("/v1/music/search?q=rick").set(auth());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "rate_limited" });
  });
});
