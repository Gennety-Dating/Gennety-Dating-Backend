import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { musicSearchLimiter } from "../rate-limit.js";
import { searchTracks, type SpotifyError } from "../../services/music/spotify.js";
import {
  listProfileMusic,
  setProfileMusic,
  type SetProfileMusicError,
} from "../../services/music/profile-music.js";

/**
 * Music on the profile (decision 2026-09-11), native client (JWT).
 *
 *   GET /v1/me/music          — the caller's pinned tracks, in order
 *   PUT /v1/me/music          — replace them with `{ trackIds }` (0..3)
 *   GET /v1/music/search?q=   — Spotify catalogue search, no Spotify login
 *
 * Both routers sit behind the PROFILE_MUSIC_ENABLED gate in server.ts, so a
 * switched-off feature is a 404 before auth — the same signal that tells the
 * client to hide the section.
 */

const QUERY_MIN_LENGTH = 2;
const QUERY_MAX_LENGTH = 100;

/**
 * Spotify's own trouble is never OUR 429. That status tells the generated iOS
 * client "you, slow down", while a Spotify quota hit belongs to the whole app
 * and says nothing about this caller — so it is a 503 with the reason.
 */
export function musicErrorStatus(error: SpotifyError | SetProfileMusicError): number {
  switch (error) {
    case "invalid_track_ids":
    case "too_many_tracks":
    case "duplicate_tracks":
      return 400;
    case "track_not_found":
    case "not_found":
      return 422;
    case "upstream_unavailable":
      return 502;
    case "rate_limited":
    case "not_configured":
      return 503;
  }
}

export function createProfileMusicRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    res.json({ tracks: await listProfileMusic(req.userId as string) });
  });

  router.put("/", async (req: Request, res: Response): Promise<void> => {
    const trackIds = (req.body as { trackIds?: unknown } | undefined)?.trackIds;
    const result = await setProfileMusic(req.userId as string, trackIds);
    if (!result.ok) {
      res.status(musicErrorStatus(result.error)).json({ error: result.error });
      return;
    }
    res.json({ tracks: result.tracks });
  });

  return router;
}

export function createMusicSearchRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  // After auth, so the limiter keys on the person rather than a campus NAT.
  router.use(musicSearchLimiter);

  router.get("/search", async (req: Request, res: Response): Promise<void> => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < QUERY_MIN_LENGTH || query.length > QUERY_MAX_LENGTH) {
      res.status(400).json({ error: "bad_query" });
      return;
    }
    const result = await searchTracks(query);
    if (!result.ok) {
      res.status(musicErrorStatus(result.error)).json({ error: result.error });
      return;
    }
    res.json({ tracks: result.value });
  });

  return router;
}
