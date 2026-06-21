import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { buildPlacesPhotoUrl } from "../../services/venue.js";
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

/**
 * Google Places photo *resource name* shape (`places/<id>/photos/<id>`). We
 * only ever proxy strings matching this so the endpoint can't be turned into an
 * open fetch proxy for arbitrary Google URLs.
 */
const PHOTO_REF_REGEX = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_.-]+$/;

export function createVenueChangeRouter(api: Api<RawApi>): Router {
  const router = Router();

  // GET /photo?ref=<places photo resource name>&w=<px>&tma=<initData>
  //
  // Server-side image proxy for the detail-page gallery. `<img>` tags can't
  // send an Authorization header, so initData rides the `tma` query param and
  // is HMAC-verified exactly like the header path — only an authenticated
  // Telegram user (of our bot) can pull venue photos, and the `PLACES_API_KEY`
  // never leaves the server. Curated photos are absolute URLs the client loads
  // directly, so only the Places fallback uses this.
  router.get("/photo", async (req: Request, res: Response): Promise<void> => {
    const initData = typeof req.query.tma === "string" ? req.query.tma : "";
    if (!initData) {
      res.status(401).json({ error: "Missing tma initData" });
      return;
    }
    if (!validateInitData(initData, env.BOT_TOKEN).valid) {
      res.status(401).json({ error: "Invalid initData" });
      return;
    }

    const ref = typeof req.query.ref === "string" ? req.query.ref : "";
    if (!PHOTO_REF_REGEX.test(ref)) {
      res.status(400).json({ error: "bad-ref" });
      return;
    }

    const apiKey = process.env.PLACES_API_KEY;
    if (!apiKey) {
      res.status(404).json({ error: "photos-unavailable" });
      return;
    }

    const width = clampWidth(req.query.w);
    const url = buildPlacesPhotoUrl(ref, apiKey, width);
    if (!url) {
      res.status(404).json({ error: "photos-unavailable" });
      return;
    }

    try {
      const upstream = await fetch(url);
      if (!upstream.ok) {
        res.status(502).json({ error: "upstream" });
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
      // Cache so the same image used as a list thumbnail and a detail hero
      // isn't re-fetched from Google. Private — it's tied to the signed ref.
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.status(200).send(buf);
    } catch (err) {
      console.warn("[venue-change] photo proxy failed:", err);
      res.status(502).json({ error: "upstream" });
    }
  });

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

/** Clamp a requested photo width to a sane range (thumb → hero). */
function clampWidth(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 1000;
  return Math.min(1600, Math.max(200, Math.round(n)));
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
