import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import {
  getVenueChangeState,
  getVenueChangeCatalog,
  proposeVenueChange,
  type ProposeVenueChangeResult,
} from "../../handlers/matching/venue-change.js";

/**
 * Venue change Mini App endpoints (PRODUCT_SPEC §3.7 — female-exclusive
 * one-shot swap). Authenticated with `Authorization: tma <initData>` (Telegram
 * HMAC, NOT JWT) — same boundary as /v1/calendar, /v1/location, /v1/feedback.
 *
 *   GET  /v1/venue-change/state?match=<id>   — eligibility + original venue
 *   GET  /v1/venue-change/catalog?match=<id> — alternatives within 3 km
 *   POST /v1/venue-change/propose            — submit a pick + mandatory comment
 *
 * Eligibility, one-shot, comment-length, and within-radius re-validation all
 * live server-side in the handler module — the route is a thin HTTP boundary
 * that maps result reasons to status codes.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createVenueChangeRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.get("/state", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOfQuery(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const result = await getVenueChangeState(BigInt(auth.user.id), matchId);
    if (!result.ok) {
      res.status(result.reason === "not-participant" ? 403 : 404).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true, ...result.state });
  });

  router.get("/catalog", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOfQuery(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const result = await getVenueChangeCatalog(BigInt(auth.user.id), matchId);
    if (!result.ok) {
      res.status(statusForReason(result.reason)).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true, venues: result.venues });
  });

  router.post("/propose", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const matchId = typeof body?.matchId === "string" ? body.matchId : null;
    if (!matchId || !UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }

    const name = typeof body?.name === "string" ? body.name : "";
    const address = typeof body?.address === "string" ? body.address : "";
    const lat = typeof body?.lat === "number" ? body.lat : NaN;
    const lng = typeof body?.lng === "number" ? body.lng : NaN;
    const comment = typeof body?.comment === "string" ? body.comment : "";
    const placeId = typeof body?.placeId === "string" && body.placeId ? body.placeId : null;
    const mapsUri = typeof body?.mapsUri === "string" && body.mapsUri ? body.mapsUri : null;

    if (!name.trim() || Number.isNaN(lat) || Number.isNaN(lng)) {
      res.status(400).json({ error: "invalid-venue" });
      return;
    }

    const result = await proposeVenueChange(api, BigInt(auth.user.id), matchId, {
      placeId,
      name,
      address,
      lat,
      lng,
      mapsUri,
      comment,
    });
    if (!result.ok) {
      res.status(statusForProposeReason(result.reason)).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true });
  });

  return router;
}

function matchIdOfQuery(req: Request): string | null {
  const raw = typeof req.query.match === "string" ? req.query.match : "";
  return UUID_REGEX.test(raw) ? raw : null;
}

function statusForReason(
  reason: VenueChangeCatalogReason,
): number {
  switch (reason) {
    case "match-not-found":
    case "no-venue":
      return 404;
    case "not-participant":
    case "feature-disabled":
    case "not-female-initiator":
      return 403;
    case "already-used":
    case "past-cutoff":
      return 409;
    default:
      return 400; // wrong-state
  }
}

function statusForProposeReason(reason: ProposeReason): number {
  switch (reason) {
    case "match-not-found":
      return 404;
    case "not-participant":
    case "feature-disabled":
    case "not-female-initiator":
      return 403;
    case "already-used":
    case "past-cutoff":
    case "race-lost":
    case "no-venue":
      return 409;
    default:
      return 400; // wrong-state | comment-too-short | out-of-range | invalid-venue
  }
}

type VenueChangeCatalogReason = Extract<
  Awaited<ReturnType<typeof getVenueChangeCatalog>>,
  { ok: false }
>["reason"];
type ProposeReason = Extract<ProposeVenueChangeResult, { ok: false }>["reason"];

type AuthOk = { ok: true; user: { id: number } };
type AuthErr = { ok: false; body: { error: string; reason?: string } };

function authenticate(req: Request): AuthOk | AuthErr {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, body: { error: "Missing tma initData" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) return { ok: false, body: { error: "Empty initData" } };
  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, body: { error: "Invalid initData", reason: validation.reason } };
  }
  return { ok: true, user: { id: validation.user.id } };
}
