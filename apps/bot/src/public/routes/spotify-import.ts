import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { spotifyImportLimiter } from "../rate-limit.js";
import {
  completeTopTracksImport,
  peekTopTracksImport,
  startTopTracksImport,
  topTracksImportConfigured,
} from "../../services/music/spotify-oauth.js";

/**
 * The one-time Spotify top-tracks import (decision 2026-09-11). The flow, and
 * why nothing about the Spotify account is stored: services/music/spotify-oauth.ts.
 *
 *   POST /v1/integrations/spotify/authorize   (JWT) → { authorizeUrl }
 *   GET  /v1/integrations/spotify/callback    Spotify's redirect. No JWT — the
 *        single-use `state` minted by /authorize is the binding. Always ends in
 *        a 302 to `gennety://spotify-import?status=…`, which closes the app's
 *        web session.
 *   GET  /v1/integrations/spotify/top-tracks  (JWT) → { tracks } | 404
 *
 * The callback is deliberately absent from the OpenAPI spec: no client calls
 * it, a browser does — the same reason `/v1/promo` and `/v1/founder` are not
 * there either.
 */

/** Where the callback sends the browser; the app registers the `gennety` scheme. */
export const SPOTIFY_IMPORT_RETURN_URL = "gennety://spotify-import";

export function createSpotifyImportRouter(): Router {
  const router = Router();

  router.post(
    "/authorize",
    requireAuth,
    spotifyImportLimiter,
    (req: Request, res: Response): void => {
      if (!topTracksImportConfigured()) {
        res.status(503).json({ error: "not_configured" });
        return;
      }
      res.json({ authorizeUrl: startTopTracksImport(req.userId as string) });
    },
  );

  router.get("/callback", async (req: Request, res: Response): Promise<void> => {
    const status = await completeTopTracksImport(req.query);
    // The URL carried a one-time code: nothing on the way back may cache it.
    res.set("Cache-Control", "no-store");
    res.redirect(302, `${SPOTIFY_IMPORT_RETURN_URL}?status=${status}`);
  });

  router.get("/top-tracks", requireAuth, (req: Request, res: Response): void => {
    const tracks = peekTopTracksImport(req.userId as string);
    if (!tracks) {
      res.status(404).json({ error: "no_import" });
      return;
    }
    res.json({ tracks });
  });

  return router;
}
