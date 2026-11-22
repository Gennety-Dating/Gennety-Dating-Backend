import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { shareMusicAddLimiter, shareMusicLimiter } from "../rate-limit.js";
import { appendProfileMusic } from "../../services/music/profile-music.js";
import { readSharedMusic, type ShareMusicReadDeps } from "../../services/share-music/read.js";
import { musicErrorStatus } from "./music.js";

/**
 * «Поделиться → Gennety» for a playlist, an album or a track — the iOS share
 * extension's music side (decision 2026-11-22).
 *
 *   POST /v1/me/share/music       — `{ url }` → the list as cards, all ticked
 *   POST /v1/me/share/music/add   — `{ tracks: [{ provider, trackId, storefront? }] }`
 *                                   → appended to the profile's music in one go
 *
 * Mounted in server.ts behind PROFILE_MUSIC_ENABLED, BEFORE `/v1/me/share`
 * (whose router 404s everything while the wishlist is off). 400 `not-music`
 * tells the app to fall back to `/v1/me/share/video`, then to the wishlist —
 * which is also what an older server without this router answers (404), so
 * the client falls back on either.
 */

const URL_MAX = 2000;

export interface ShareMusicRouterDeps {
  read?: ShareMusicReadDeps;
}

export function createShareMusicRouter(deps: ShareMusicRouterDeps = {}): Router {
  const router = Router();
  router.use(requireAuth);

  router.post("/", shareMusicLimiter, async (req: Request, res: Response): Promise<void> => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!url || url.length > URL_MAX) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    const result = await readSharedMusic(url, req.userId!, deps.read);
    if (!result.ok) {
      res.status(400).json({ error: "not-music" });
      return;
    }
    res.json(result.music);
  });

  router.post("/add", shareMusicAddLimiter, async (req: Request, res: Response): Promise<void> => {
    const result = await appendProfileMusic(req.userId!, ((req.body ?? {}) as { tracks?: unknown }).tracks);
    if (!result.ok) {
      // `too_many_tracks` here means the profile is already full — a conflict
      // with what is stored, not a malformed request.
      const status = result.error === "too_many_tracks" ? 409 : musicErrorStatus(result.error);
      res.status(status).json({ error: result.error });
      return;
    }
    res.json({ tracks: result.tracks, added: result.added, skipped: result.skipped });
  });

  return router;
}
