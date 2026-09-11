import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = {
  PROFILE_MUSIC_ENABLED: true,
  SPOTIFY_TOP_TRACKS_ENABLED: true,
  JWT_SECRET,
  BOT_TOKEN: "123456:test-bot-token",
};
vi.mock("../../config.js", () => ({ env }));

const h = vi.hoisted(() => ({
  configured: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  peek: vi.fn(),
}));
vi.mock("../../services/music/spotify-oauth.js", () => ({
  topTracksImportConfigured: h.configured,
  startTopTracksImport: h.start,
  completeTopTracksImport: h.complete,
  peekTopTracksImport: h.peek,
}));

const { createSpotifyImportRouter } = await import("./spotify-import.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

/** Mirrors the two-flag gate in server.ts. */
function buildApp() {
  const app = express();
  app.use(express.json());
  const router = createSpotifyImportRouter();
  app.use("/v1/integrations/spotify", (req: Request, res: Response, next: NextFunction) => {
    if (!env.PROFILE_MUSIC_ENABLED || !env.SPOTIFY_TOP_TRACKS_ENABLED) {
      res.status(404).json({ error: "spotify-import-disabled" });
      return;
    }
    router(req, res, next);
  });
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
  env.SPOTIFY_TOP_TRACKS_ENABLED = true;
  h.configured.mockReturnValue(true);
  h.start.mockReturnValue("https://accounts.spotify.com/authorize?state=s");
  h.complete.mockResolvedValue("ok");
  h.peek.mockReturnValue(null);
});

describe("the gate", () => {
  it("is shut unless BOTH flags are on", async () => {
    env.SPOTIFY_TOP_TRACKS_ENABLED = false;
    expect((await request(buildApp()).post("/v1/integrations/spotify/authorize").set(auth())).status).toBe(404);
    env.SPOTIFY_TOP_TRACKS_ENABLED = true;
    env.PROFILE_MUSIC_ENABLED = false;
    expect((await request(buildApp()).get("/v1/integrations/spotify/callback?state=s")).status).toBe(404);
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe("POST /authorize", () => {
  it("needs a JWT", async () => {
    expect((await request(buildApp()).post("/v1/integrations/spotify/authorize")).status).toBe(401);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("returns Spotify's URL for the caller", async () => {
    const res = await request(buildApp()).post("/v1/integrations/spotify/authorize").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorizeUrl: "https://accounts.spotify.com/authorize?state=s" });
    expect(h.start).toHaveBeenCalledWith(USER_ID);
  });

  it("answers 503 rather than a URL that cannot work", async () => {
    h.configured.mockReturnValue(false);
    const res = await request(buildApp()).post("/v1/integrations/spotify/authorize").set(auth());
    expect(res.status).toBe(503);
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe("GET /callback", () => {
  it("needs no JWT and always bounces the browser back to the app", async () => {
    h.complete.mockResolvedValue("cancelled");
    const res = await request(buildApp()).get(
      "/v1/integrations/spotify/callback?state=s&error=access_denied",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("gennety://spotify-import?status=cancelled");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(h.complete).toHaveBeenCalledWith(
      expect.objectContaining({ state: "s", error: "access_denied" }),
    );
  });
});

describe("GET /top-tracks", () => {
  it("is 404 when there is no fresh import", async () => {
    const res = await request(buildApp()).get("/v1/integrations/spotify/top-tracks").set(auth());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "no_import" });
  });

  it("returns the caller's candidates", async () => {
    h.peek.mockReturnValue([{ spotifyTrackId: "4uLU6hMCjMI75M1A2tKUQC" }]);
    const res = await request(buildApp()).get("/v1/integrations/spotify/top-tracks").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tracks: [{ spotifyTrackId: "4uLU6hMCjMI75M1A2tKUQC" }] });
    expect(h.peek).toHaveBeenCalledWith(USER_ID);
  });
});
