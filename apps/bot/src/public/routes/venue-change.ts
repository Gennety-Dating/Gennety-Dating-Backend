import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { buildPlacesPhotoUrl } from "../../services/venue.js";
import { prisma } from "@gennety/db";
import { readResponseBuffer } from "../../utils/bounded-response.js";
import {
  getVenueBoardState,
  getVenueChangeCatalog,
  submitVenueLikes,
  confirmVenueAgreement,
  offerPartnerPay,
  declineVenuePay,
  keepOriginalVenue,
  mintExpressChange,
  settleFreeVenueChange,
  createVenueInvoiceLink,
} from "../../handlers/matching/venue-change.js";

/**
 * Venue change v2 Mini App endpoints (PRODUCT_SPEC §3.7b — paid multiplayer
 * board). Authenticated with `Authorization: tma <initData>` (Telegram HMAC,
 * NOT JWT) — same boundary as /v1/calendar, /v1/location, /v1/feedback.
 *
 *   GET  /v1/venue-change/state?match=<id>    — board snapshot (polled ~4s)
 *   GET  /v1/venue-change/catalog?match=<id>  — alternatives within 3 km
 *   GET  /v1/venue-change/photo               — Places photo proxy (unchanged)
 *   POST /v1/venue-change/like                — full like-set submission
 *   POST /v1/venue-change/confirm             — resolve a multi-overlap
 *   POST /v1/venue-change/offer-pay           — her wish card to him
 *   POST /v1/venue-change/pay-decline         — his in-app "not this time"
 *   POST /v1/venue-change/stars-invoice       — mint the 150⭐ invoice link
 *                                               (mode: agreed | express)
 *
 * All state transitions, payer-matrix checks, and CAS guards live in the
 * handler module — the routes are a thin HTTP boundary.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Google Places photo *resource name* shape (`places/<id>/photos/<id>`). We
 * only ever proxy strings matching this so the endpoint can't be turned into an
 * open fetch proxy for arbitrary Google URLs.
 */
const PHOTO_REF_REGEX = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_.-]+$/;
const PHOTO_PROXY_TIMEOUT_MS = 10_000;
const PHOTO_PROXY_MAX_BYTES = 10 * 1024 * 1024;

export function createVenueChangeRouter(api: Api<RawApi>): Router {
  const router = Router();

  // GET /photo?ref=<places photo resource name>&w=<px>&tma=<initData>
  //
  // Server-side image proxy for the board/detail galleries. `<img>` tags can't
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
      const upstream = await fetch(url, {
        signal: AbortSignal.timeout(PHOTO_PROXY_TIMEOUT_MS),
      });
      if (!upstream.ok) {
        res.status(502).json({ error: "upstream" });
        return;
      }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("image/")) {
        await upstream.body?.cancel();
        res.status(502).json({ error: "upstream" });
        return;
      }
      const buf = await readResponseBuffer(upstream, PHOTO_PROXY_MAX_BYTES);
      res.setHeader("Content-Type", contentType);
      // Cache so the same image used as a card thumbnail and a detail hero
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
    const result = await getVenueBoardState(BigInt(auth.user.id), matchId);
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

  // Full like-set submission (calendar `pick` semantics). Body: { matchId,
  // keys: string[] }. Response: { agreed, overlapCandidates } — the client
  // re-fetches /state after.
  router.post("/like", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const matchId = matchIdOfBody(body);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const keys = parseKeys(body?.keys);
    if (!keys) {
      res.status(400).json({ error: "invalid-keys" });
      return;
    }

    const result = await submitVenueLikes(api, BigInt(auth.user.id), matchId, keys);
    if (!result.ok) {
      res.status(statusForReason(result.reason)).json({ error: result.reason });
      return;
    }
    res
      .status(200)
      .json({ ok: true, agreed: result.agreed, overlapCandidates: result.overlapCandidates });
  });

  // Resolve a multi-overlap: the actor picks one venue both sides liked.
  router.post("/confirm", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const matchId = matchIdOfBody(body);
    const key = typeof body?.key === "string" ? body.key : "";
    if (!matchId || !key) {
      res.status(400).json({ error: "invalid-request" });
      return;
    }
    const result = await confirmVenueAgreement(api, BigInt(auth.user.id), matchId, key);
    if (!result.ok) {
      res.status(statusForReason(result.reason)).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true });
  });

  // Her one-shot "offer him to pay" — sends the wish card to his chat.
  router.post("/offer-pay", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOfBody(req.body as Record<string, unknown> | undefined);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const result = await offerPartnerPay(api, BigInt(auth.user.id), matchId);
    if (!result.ok) {
      res.status(statusForReason(result.reason)).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true });
  });

  // "Stay where we were" — withdraw my marks, and call off an agreement if one
  // was reached. The explicit way back to the originally assigned venue.
  router.post("/keep-original", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOfBody(req.body as Record<string, unknown> | undefined);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const result = await keepOriginalVenue(api, BigInt(auth.user.id), matchId);
    if (!result.ok) {
      res.status(statusForReason(result.reason)).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true, toldPartner: result.toldPartner });
  });

  // His in-app "not this time" (the Mini App fork twin of the wish-card button).
  router.post("/pay-decline", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOfBody(req.body as Record<string, unknown> | undefined);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const result = await declineVenuePay(api, BigInt(auth.user.id), matchId);
    if (!result.ok) {
      res.status(409).json({ error: "wrong-state" });
      return;
    }
    res.status(200).json({ ok: true });
  });

  // Mint the Stars invoice link the Mini App opens with WebApp.openInvoice().
  // Body: { matchId, mode: "agreed" } — pay the agreed venue (payer or her
  // parallel pay-self path); or { matchId, mode: "express", key } — her
  // unilateral instant swap (stamps the express mint first).
  router.post("/stars-invoice", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const matchId = matchIdOfBody(body);
    const mode = body?.mode === "express" ? "express" : body?.mode === "agreed" ? "agreed" : null;
    if (!matchId || !mode) {
      res.status(400).json({ error: "invalid-request" });
      return;
    }

    let venueName: string;
    if (mode === "express") {
      const key = typeof body?.key === "string" ? body.key : "";
      if (!key) {
        res.status(400).json({ error: "invalid-request" });
        return;
      }
      const mint = await mintExpressChange(BigInt(auth.user.id), matchId, key);
      if (!mint.ok) {
        res.status(statusForReason(mint.reason)).json({ error: mint.reason });
        return;
      }
      // Premium free express: no invoice — settle instantly and tell the Mini
      // App it's done (§Premium).
      if (mint.free) {
        const settled = await settleFreeVenueChange(api, BigInt(auth.user.id), matchId);
        if (!settled.ok) {
          res.status(409).json({ error: settled.reason ?? "wrong-state" });
          return;
        }
        res.status(200).json({ ok: true, settled: true, free: true });
        return;
      }
      venueName = mint.venueName;
    } else {
      // "agreed": re-derive the caller's paying rights from the board state —
      // the payer, his fork, or her pay-self path all have a paying action.
      const state = await getVenueBoardState(BigInt(auth.user.id), matchId);
      if (!state.ok) {
        res.status(state.reason === "not-participant" ? 403 : 404).json({ error: state.reason });
        return;
      }
      const action = state.state.myAction;
      const mayPay =
        action === "pay" || action === "pay_or_decline" || action === "pay_or_offer";
      if (!state.state.agreed || !mayPay) {
        res.status(409).json({ error: "wrong-state" });
        return;
      }
      venueName = state.state.agreed.name;
    }

    const lang = await langForTelegramId(auth.user.id);
    try {
      const link = await createVenueInvoiceLink(api, lang, matchId, mode, venueName);
      res.status(200).json({ ok: true, link, stars: env.VENUE_CHANGE_STARS });
    } catch (err) {
      console.error("[venue-change] createInvoiceLink failed:", err);
      res.status(502).json({ error: "invoice-failed" });
    }
  });

  return router;
}

async function langForTelegramId(telegramId: number): Promise<Language> {
  const user = await prisma.user
    .findUnique({ where: { telegramId: BigInt(telegramId) }, select: { language: true } })
    .catch(() => null);
  return (user?.language ?? "en") as Language;
}

function matchIdOfQuery(req: Request): string | null {
  const raw = typeof req.query.match === "string" ? req.query.match : "";
  return UUID_REGEX.test(raw) ? raw : null;
}

function matchIdOfBody(body: Record<string, unknown> | undefined): string | null {
  const raw = typeof body?.matchId === "string" ? body.matchId : "";
  return UUID_REGEX.test(raw) ? raw : null;
}

/** Like keys: up to the catalog cap, non-empty strings, sane length. */
function parseKeys(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 30) return null;
  const keys: string[] = [];
  for (const k of raw) {
    if (typeof k !== "string" || !k || k.length > 600) return null;
    keys.push(k);
  }
  return keys;
}

/** Clamp a requested photo width to a sane range (thumb → hero). */
function clampWidth(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 1000;
  return Math.min(1600, Math.max(200, Math.round(n)));
}

function statusForReason(reason: string): number {
  switch (reason) {
    case "match-not-found":
    case "no-venue":
      return 404;
    case "not-participant":
    case "feature-disabled":
    case "not-allowed":
      return 403;
    // Premium-gated pick — the Mini App turns this into the subscribe CTA.
    case "premium-locked":
      return 402;
    case "already-changed":
    case "past-cutoff":
    case "already-offered":
    case "pay-declined":
    case "not-overlapping":
      return 409;
    default:
      return 400; // wrong-state | invalid-venue | invalid-keys
  }
}

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
