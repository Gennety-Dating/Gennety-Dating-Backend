import { Router, type Request, type Response } from "express";

import { requireCanvasAuth } from "../canvas-auth.js";
import { canvasLimiter } from "../rate-limit.js";
import { readDateMap } from "../../services/date-map.js";

/**
 * `GET /v1/date-map` — the places this person has been on a confirmed date,
 * the count, and the vibes those places share (living-canvas.md §6.5).
 *
 * Read-only and derived from `Match` rows: nothing about it is collected, so
 * there is no ping and no opt-in — the two calls the retired Scratch Map
 * needed to fill a fog with tiles.
 *
 * Either rail: the profile asks on iOS, the Date Terminal could in the Mini
 * App, and the map belongs to the person rather than to the client.
 */
export const dateMapRouter: Router = Router();

dateMapRouter.use(requireCanvasAuth);
dateMapRouter.use(canvasLimiter);

dateMapRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const map = await readDateMap(req.userId!);
  res.json({
    confirmedDates: map.confirmedDates,
    places: map.places.map((place) => ({
      ...place,
      lastDateAt: place.lastDateAt.toISOString(),
    })),
    vibes: map.vibes,
  });
});
