import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";

import { requireCanvasAuth } from "../canvas-auth.js";
import { sideOf } from "../../services/date-state.js";
import {
  checkRadarWindow,
  estimateEta,
  hasArrived,
  isTravelMode,
  recordPresence,
  viewOfPeer,
} from "../../services/date-radar.js";

/**
 * `POST /v1/dates/:matchId/proximity` — one side's position ping
 * (PRODUCT_SPEC §6.3).
 *
 * Ping-and-read: you tell the server where you are, and it tells you about
 * your PARTNER — one word and, if they are moving, one wall-clock time. It is
 * one endpoint rather than a write plus a poll because the two are the same
 * moment: the canvas is open, both phones are pinging, and each ping is the
 * natural place to hand back what the other one said.
 *
 * **The response is the privacy boundary, and it is a closed shape.** No
 * coordinate, no distance, no address, no "500 m away" — those are all the
 * same disclosure at different resolutions, and the invariant this feature
 * exists under (§6, and §Phase 4's own safety brief) is that a person's exact
 * position is never revealed to their match. `viewOfPeer` is where masking
 * happens; this route only forwards its result, and a test asserts the wire
 * carries none of those words.
 *
 * The ping's own coordinates are used and dropped. They are never written to
 * the database (`services/date-radar.ts` says why) and never logged.
 */
export const dateRadarRouter: Router = Router();

// Either rail: the canvas is one screen on two clients (see canvas-auth.ts).
dateRadarRouter.use(requireCanvasAuth);

const REFUSAL_STATUS: Record<string, number> = {
  // Authenticated but on neither side — 404 rather than 403, so the endpoint
  // cannot be used to probe which match ids exist. Same rule as the Bump.
  "not-participant": 404,
  "wrong-state": 409,
  "too-early": 409,
  "too-late": 409,
};

dateRadarRouter.post(
  "/:matchId/proximity",
  async (req: Request, res: Response): Promise<void> => {
    const matchId = (req.params as Record<string, string | undefined>).matchId;
    if (!matchId || !isUuid(matchId)) {
      res.status(400).json({ error: "matchId must be a UUID" });
      return;
    }

    const body = req.body as { lat?: unknown; lng?: unknown; mode?: unknown };
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: "lat and lng are required" });
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400).json({ error: "lat/lng out of range" });
      return;
    }
    // An unknown mode is ignored rather than refused: the estimator derives a
    // sensible one from the distance, so a client sending a mode this server
    // does not know yet gets a slightly rougher ETA instead of an error.
    const mode = isTravelMode(body.mode) ? body.mode : undefined;

    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        status: true,
        userAId: true,
        userBId: true,
        agreedTime: true,
        venueLat: true,
        venueLng: true,
      },
    });

    const side = match ? sideOf(match, req.userId!) : null;
    if (!match || !side) {
      res.status(REFUSAL_STATUS["not-participant"]!).json({ error: "not-participant" });
      return;
    }
    if (
      match.status !== "scheduled" ||
      !match.agreedTime ||
      match.venueLat === null ||
      match.venueLng === null
    ) {
      res.status(409).json({ error: "wrong-state" });
      return;
    }

    const now = new Date();
    const window = checkRadarWindow(match.agreedTime, now);
    if (window !== "ok") {
      res.status(409).json({ error: window });
      return;
    }

    const venue = { lat: match.venueLat, lng: match.venueLng };
    const here = { lat, lng };
    const arrived = hasArrived(here, venue);
    const eta = arrived ? null : estimateEta(here, venue, mode);

    recordPresence(
      match.id,
      side,
      {
        arrived,
        ...(eta ? { etaAt: new Date(now.getTime() + eta.minutes * 60_000) } : {}),
      },
      now,
    );

    // The caller's OWN city zone. Matching is same-city (§3.2 filter 5), so
    // the two agree by construction — reading the caller's own is what keeps a
    // partner's profile out of a request that is already about their location.
    const profile = await prisma.profile.findUnique({
      where: { userId: req.userId! },
      select: { timeZone: true },
    });

    res.json({
      ok: true,
      arrived,
      ...viewOfPeer(match.id, side, now, profile?.timeZone ?? "Europe/Kyiv"),
    });
  },
);

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
