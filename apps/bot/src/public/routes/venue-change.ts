import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { verifyAccessToken } from "../jwt.js";
import { buildPlacesPhotoUrl } from "../../services/venue.js";
import { prisma } from "@gennety/db";
import { fetchPlacesPhoto, snapWidth } from "../places-photo.js";
import {
  boardPhotoLinks,
  boardPhotoSignatureValid,
  decodePhotoRef,
} from "../venue-change-photos.js";
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
import { recordMiniAppAction } from "../../services/chat-events.js";
import { startPeerWaitShimmer } from "../../services/peer-wait.js";
import { allowCrossOriginImage } from "../cross-origin-image.js";
import { photoProxyLimiter } from "../rate-limit.js";

/** Chat-timeline shorthand — every action on this board is one surface. */
function noteBoardAction(telegramId: number, matchId: string, what: string): void {
  recordMiniAppAction(telegramId, what, { surface: "venue_change", matchId });
}

/**
 * Venue change v2 board endpoints (PRODUCT_SPEC §3.7b — paid multiplayer
 * board), serving BOTH clients since 2026-09-12.
 *
 * Authenticated with `Authorization: tma <initData>` (Telegram HMAC) OR
 * `Authorization: Bearer <jwt>` (the native client) — see `authenticate` at
 * the foot of this file for why the second rail lands here instead of in a
 * parallel family of routes. Before that date this was Telegram-only and
 * deliberately outside the OpenAPI contract, which is what put the iOS venue
 * board out of reach (decision 2026-08-20).
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
 *   POST /v1/venue-change/appstore/transaction — settle from a StoreKit
 *                                               consumable (native rail only)
 *   GET  /v1/venue-change/photo/:token         — Places photo by signed link
 *                                               (native rail; no header to
 *                                                send from an image loader)
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
  router.get("/photo", photoProxyLimiter, async (req: Request, res: Response): Promise<void> => {
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

    const width = snapWidth(req.query.w);
    const url = buildPlacesPhotoUrl(ref, apiKey, width);
    if (!url) {
      res.status(404).json({ error: "photos-unavailable" });
      return;
    }

    // Retries and both log lines live in `places-photo.ts`, shared with the
    // iOS canvas's own proxy (`/v1/venues/:id/photo`) — see there for which
    // failures are worth a second attempt and why.
    const result = await fetchPlacesPhoto(url, "[venue-change]");
    if (!result.ok) {
      res.status(502).json({ error: "upstream" });
      return;
    }
    res.setHeader("Content-Type", result.contentType);
    allowCrossOriginImage(res);
    // Cache so the same image used as a card thumbnail and a detail hero
    // isn't re-fetched from Google. Private — it's tied to the signed ref.
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.status(200).send(result.body);
  });

  // GET /photo/:token?w=<px>&e=<expiry>&sig=<hmac>
  //
  // The same picture as `/photo` above, for a client that cannot send a header
  // OR an initData. The link itself is the permission (`venue-change-photos.ts`
  // says why, and why the ref is a path segment rather than a query value).
  // Minted only by the catalog and state responses, so this is no more an open
  // Places proxy than the `tma` path is.
  router.get(
    "/photo/:token",
    photoProxyLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const token = typeof req.params.token === "string" ? req.params.token : "";
      const ref = decodePhotoRef(token);
      if (!ref || !PHOTO_REF_REGEX.test(ref)) {
        res.status(400).json({ error: "bad-ref" });
        return;
      }

      // Snap BEFORE verifying: the signature is over the width actually used,
      // so a request that snapped to a different width must fail rather than
      // silently serve a size nobody signed for.
      const width = snapWidth(req.query.w);
      const expiresAt = Number(req.query.e);
      const sig = typeof req.query.sig === "string" ? req.query.sig : "";
      if (!boardPhotoSignatureValid(token, width, expiresAt, sig)) {
        res.status(403).json({ error: "bad-signature" });
        return;
      }

      const apiKey = process.env.PLACES_API_KEY;
      if (!apiKey) {
        res.status(404).json({ error: "photos-unavailable" });
        return;
      }
      const url = buildPlacesPhotoUrl(ref, apiKey, width);
      if (!url) {
        res.status(404).json({ error: "photos-unavailable" });
        return;
      }

      const result = await fetchPlacesPhoto(url, "[venue-change]");
      if (!result.ok) {
        res.status(502).json({ error: "upstream" });
        return;
      }
      res.setHeader("Content-Type", result.contentType);
      allowCrossOriginImage(res);
      // Public rather than private: unlike the `tma` path this link is bound to
      // no viewer at all (a cafe's photograph is nobody's personal data), and
      // the day-rounded expiry is what bounds it. Same trade as the canvas.
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.status(200).send(result.body);
    },
  );

  router.get("/state", async (req: Request, res: Response): Promise<void> => {
    const auth = await authenticate(req);
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
    const now = Date.now();
    res.status(200).json({
      ok: true,
      ...result.state,
      original: {
        ...result.state.original,
        ...boardPhotoLinks(result.state.original.photoRefs?.[0] ?? null, now),
      },
    });
  });

  router.get("/catalog", async (req: Request, res: Response): Promise<void> => {
    const auth = await authenticate(req);
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
    // Signed photo links, minted alongside the refs rather than instead of
    // them: the deployed Mini App builds its own `?tma=` URLs from `photoRefs`
    // and must keep working untouched, while the native client — which has no
    // initData to put in a query — reads `photoUrl`/`thumbnailUrl`. Additive,
    // so neither client is on the other's schedule.
    const now = Date.now();
    res.status(200).json({
      ok: true,
      venues: result.venues.map((v) => ({
        ...v,
        ...boardPhotoLinks(v.photoRefs?.[0] ?? null, now),
      })),
    });
  });

  // Full like-set submission (calendar `pick` semantics). Body: { matchId,
  // keys: string[] }. Response: { agreed, overlapCandidates } — the client
  // re-fetches /state after.
  router.post("/like", async (req: Request, res: Response): Promise<void> => {
    const auth = await authenticate(req);
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
    noteBoardAction(
      auth.user.id,
      matchId,
      result.agreed
        ? "in the Change venue Mini App, liked a place their partner had also liked — the pair agreed on a new venue"
        : `in the Change venue Mini App, hearted ${keys.length} alternative place(s)`,
    );
    // Chat cue for the wait that follows (PRODUCT_SPEC §3.6b). The board polls
    // at ~4s, but only while the Mini App is OPEN — close it and the chat used
    // to say nothing at all. Started here so it is already on screen behind the
    // Mini App; `workers/peer-wait-shimmer.ts` re-derives and holds it.
    startPeerWaitShimmer(api, matchId, { telegramId: BigInt(auth.user.id) });
    res
      .status(200)
      .json({ ok: true, agreed: result.agreed, overlapCandidates: result.overlapCandidates });
  });

  // Resolve a multi-overlap: the actor picks one venue both sides liked.
  router.post("/confirm", async (req: Request, res: Response): Promise<void> => {
    const auth = await authenticate(req);
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
    noteBoardAction(
      auth.user.id,
      matchId,
      "in the Change venue Mini App, picked which of the mutually-liked places the pair agreed on",
    );
    startPeerWaitShimmer(api, matchId, { telegramId: BigInt(auth.user.id) });
    res.status(200).json({ ok: true });
  });

  // Her one-shot "offer him to pay" — sends the wish card to his chat.
  router.post("/offer-pay", async (req: Request, res: Response): Promise<void> => {
    const auth = await authenticate(req);
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
    noteBoardAction(
      auth.user.id,
      matchId,
      "in the Change venue Mini App, asked their partner to lock in the new venue (the wish card was sent to him)",
    );
    // She has just handed the decision over — this is the exact moment she
    // starts waiting on him (see `peer-wait-venue-change.ts`).
    startPeerWaitShimmer(api, matchId, { telegramId: BigInt(auth.user.id) });
    res.status(200).json({ ok: true });
  });

  // "Stay where we were" — withdraw my marks, and call off an agreement if one
  // was reached. The explicit way back to the originally assigned venue.
  router.post("/keep-original", async (req: Request, res: Response): Promise<void> => {
    const auth = await authenticate(req);
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
    noteBoardAction(
      auth.user.id,
      matchId,
      'in the Change venue Mini App, chose "Keep this place" — no venue change, the originally assigned venue stands',
    );
    res.status(200).json({ ok: true, toldPartner: result.toldPartner });
  });

  // His in-app "not this time" (the Mini App fork twin of the wish-card button).
  router.post("/pay-decline", async (req: Request, res: Response): Promise<void> => {
    const auth = await authenticate(req);
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
    noteBoardAction(
      auth.user.id,
      matchId,
      'in the Change venue Mini App, chose "Not this time" — the venue change is off and the original venue stands',
    );
    res.status(200).json({ ok: true });
  });

  // Mint the Stars invoice link the Mini App opens with WebApp.openInvoice().
  // Body: { matchId, mode: "agreed" } — pay the agreed venue (payer or her
  // parallel pay-self path); or { matchId, mode: "express", key } — her
  // unilateral instant swap (stamps the express mint first).
  router.post("/stars-invoice", async (req: Request, res: Response): Promise<void> => {
    const auth = await authenticate(req);
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
        noteBoardAction(
          auth.user.id,
          matchId,
          `in the Change venue Mini App, changed the venue to ${mint.venueName} (free with Premium)`,
        );
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
      noteBoardAction(
        auth.user.id,
        matchId,
        `in the Change venue Mini App, opened the Stars payment sheet for ${venueName} (not paid yet)`,
      );
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
    // The wish card never reached his chat; the one-shot stamp was released, so
    // the Mini App can honestly say "not sent — try again" instead of claiming it
    // landed.
    case "send-failed":
      return 502;
    // `budget-spent` (the per-date cap on settled changes is used up — the
    // venue is final) is a real conflict with the row's state, exactly like
    // `already-changed`. Deliberately NOT a 402: there is nothing a
    // subscription or a payment could unlock here.
    case "already-changed":
    case "budget-spent":
    case "past-cutoff":
    case "already-offered":
    case "pay-declined":
    case "not-overlapping":
      return 409;
    default:
      return 400; // wrong-state | invalid-venue | invalid-keys
  }
}

/** Which client proved who it was. Only the photo links care. */
export type AuthRail = "tma" | "jwt";

type AuthOk = { ok: true; user: { id: number }; rail: AuthRail };
type AuthErr = { ok: false; body: { error: string; reason?: string } };

/**
 * Both client rails, resolved to the one identifier this module speaks.
 *
 * The board was Telegram-only until 2026-09-12, and every handler behind it
 * takes a `telegramId` — a 2000-line state machine keyed on it. The native
 * client carries a JWT whose subject is the account uuid, so the bridge is one
 * indexed lookup HERE rather than a second identity threaded through the
 * handlers: two ways to prove who you are, one notion of who that is.
 * `canvas-auth.ts` makes the same trade for the Living Canvas and argues it at
 * length; this is that argument applied to a surface whose handlers were
 * already written.
 *
 * **The lookup is safe for an account that has no Telegram.** A mobile-first
 * user still has a `telegramId` — a negative synthetic one, minted inside JS
 * safe-integer range precisely so `Number()` on it loses nothing
 * (`mobile-user.ts`) — and `sideOfUser` matches on it exactly like a real one.
 *
 * A valid signature over an account that no longer exists is 401, not 404: the
 * routes behind this deliberately refuse to distinguish "no such user" from
 * "not your match", and answering 404 here would hand back that distinction.
 */
async function authenticate(req: Request): Promise<AuthOk | AuthErr> {
  const authHeader = req.header("authorization") ?? req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!token) return { ok: false, body: { error: "Empty token" } };
    let userId: string;
    try {
      userId = verifyAccessToken(token).sub;
    } catch {
      return { ok: false, body: { error: "Invalid or expired token" } };
    }
    const user = await prisma.user
      .findUnique({ where: { id: userId }, select: { telegramId: true } })
      .catch(() => null);
    if (!user) return { ok: false, body: { error: "Invalid or expired token" } };
    return { ok: true, user: { id: Number(user.telegramId) }, rail: "jwt" };
  }

  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, body: { error: "Missing credentials" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) return { ok: false, body: { error: "Empty initData" } };
  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, body: { error: "Invalid initData", reason: validation.reason } };
  }
  return { ok: true, user: { id: validation.user.id }, rail: "tma" };
}
