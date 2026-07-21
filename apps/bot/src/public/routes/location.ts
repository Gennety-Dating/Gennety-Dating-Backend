import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { locationSearchLimiter } from "../rate-limit.js";
import {
  tryFinalize,
  sendVenuePostSaveAck,
} from "../../handlers/matching/venue-negotiation.js";
import {
  confirmVenueIntent,
  getVenueIntentState,
  interpretVenueIntent,
  venueIntentMode,
  type ConfirmVenueIntentInput,
} from "../../services/venue-intent-v2.js";

/**
 * Location Mini App endpoints (Phase 3.7 — concierge venue, map picker).
 *
 *   GET  /v1/location/search   — proxy to Places API (New) `searchText`,
 *                                so the user can type "Lukyanivska metro"
 *                                or "Khreshchatyk 14" and pick a real
 *                                place from autocomplete-style results.
 *   POST /v1/location/select   — saves the resolved lat/lng + display
 *                                address as the user's commute origin.
 *                                Triggers `tryFinalize` if vibe text is
 *                                already on file (= 4-field gate met).
 *
 * Auth: `Authorization: tma <initData>` — same convention as
 * /v1/calendar/* and /v1/feedback. Telegram-side HMAC, no JWT.
 *
 * Why a server-side proxy for search rather than calling Places API
 * directly from the Mini App: keeps `PLACES_API_KEY` off the client.
 * A leaked key here costs us money (Places isn't free); a leaked key
 * in a Mini App bundle costs us a lot more because anyone can mirror
 * the bundle and quota-drain us.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PlaceSearchHit {
  placeId: string | undefined;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export function createLocationRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.get("/venue-intent/state", async (req: Request, res: Response): Promise<void> => {
    const actor = await authenticatedUser(req, res);
    if (!actor) return;
    const matchId = typeof req.query.matchId === "string" ? req.query.matchId : "";
    if (!UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const state = await getVenueIntentState(matchId, actor.id);
    if (!state) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    res.json({ ok: true, ...state, mode: venueIntentMode(matchId) });
  });

  router.post("/venue-intent/interpret", locationSearchLimiter, async (req: Request, res: Response): Promise<void> => {
    const actor = await authenticatedUser(req, res);
    if (!actor) return;
    const matchId = typeof req.body?.matchId === "string" ? req.body.matchId : "";
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!UUID_REGEX.test(matchId) || !text || text.length > 500) {
      res.status(400).json({ error: "invalid-request" });
      return;
    }
    const intent = await interpretVenueIntent(matchId, actor.id, text, req.body?.origin ?? null);
    if (!intent) {
      res.status(409).json({ error: "wrong-state" });
      return;
    }
    res.json({ ok: true, intent });
  });

  router.put("/venue-intent/confirm", async (req: Request, res: Response): Promise<void> => {
    const actor = await authenticatedUser(req, res);
    if (!actor) return;
    const matchId = typeof req.body?.matchId === "string" ? req.body.matchId : "";
    const intent = req.body?.intent as ConfirmVenueIntentInput | undefined;
    if (!UUID_REGEX.test(matchId) || !intent) {
      res.status(400).json({ error: "invalid-request" });
      return;
    }
    const state = await confirmVenueIntent(matchId, actor.id, intent);
    if (!state) {
      res.status(409).json({ error: "draft-not-found" });
      return;
    }
    res.json({ ok: true, ...state });
  });

  router.get("/search", locationSearchLimiter, async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2) {
      res.status(200).json({ ok: true, results: [] });
      return;
    }
    if (query.length > 120) {
      res.status(400).json({ error: "Query is too long" });
      return;
    }
    // Optional bias: if the Mini App passed a center it can ride the
    // current map view as a hint. Otherwise we let Google sort by
    // global relevance — for typed queries like "metro Lukyanivska"
    // the bias usually adds little vs. a strong textual match.
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const hasBias = Number.isFinite(lat) && Number.isFinite(lng);

    // venue.ts reads this via process.env directly (it's optional,
    // fail-soft on missing) — keep the same pattern here so dev
    // bypass is consistent across both call sites.
    const apiKey = process.env.PLACES_API_KEY;
    if (!apiKey) {
      // No key locally — return a deterministic stub so the Mini App
      // can be exercised in dev without a real Google account.
      res.status(200).json({
        ok: true,
        results: stubResults(query),
      });
      return;
    }

    try {
      const results = await searchText(apiKey, query, hasBias ? { lat, lng } : null);
      res.status(200).json({ ok: true, results });
    } catch (err) {
      console.warn("[location/search] Places searchText failed:", err);
      res.status(200).json({ ok: true, results: [] });
    }
  });

  router.post("/select", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const body = req.body as
      | { matchId?: unknown; lat?: unknown; lng?: unknown; address?: unknown }
      | undefined;
    const matchId = typeof body?.matchId === "string" ? body.matchId : null;
    const lat = typeof body?.lat === "number" ? body.lat : null;
    const lng = typeof body?.lng === "number" ? body.lng : null;
    const address =
      typeof body?.address === "string" && body.address.length > 0
        ? body.address.slice(0, 256) // hard cap so we don't store novellas
        : null;

    if (!matchId || lat === null || lng === null) {
      res.status(400).json({ error: "matchId, lat, lng are required" });
      return;
    }
    if (!UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: "invalid-coords" });
      return;
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      res.status(400).json({ error: "invalid-coords" });
      return;
    }

    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        userAId: true,
        userBId: true,
        status: true,
      },
    });
    if (!match) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    if (match.status !== "negotiating_venue") {
      res.status(400).json({ error: "wrong-state" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(auth.user.id) },
      select: { id: true, language: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }

    const isA = user.id === match.userAId;
    const isB = user.id === match.userBId;
    if (!isA && !isB) {
      res.status(403).json({ error: "not-participant" });
      return;
    }

    await prisma.match.update({
      where: { id: matchId },
      data: isA
        ? { vibeLatA: lat, vibeLngA: lng, vibeAddressA: address }
        : { vibeLatB: lat, vibeLngB: lng, vibeAddressB: address },
    });

    // Send the side-aware "what's next" ACK so the chat reflects the
    // Mini App save. Without this, closing the Mini App leaves the
    // user with no chat-side cue — past UX feedback was that this
    // read as the bot ignoring them. The same helper is used by the
    // bot-side handlers, so the wording stays consistent across paths.
    const actorLang = (user.language ?? "en") as Parameters<typeof sendVenuePostSaveAck>[4];
    void sendVenuePostSaveAck(
      api,
      BigInt(auth.user.id),
      matchId,
      isA ? "A" : "B",
      actorLang,
    ).catch((err) => {
      console.warn(`[location/select] ACK failed for ${matchId}:`, err);
    });

    // Fire-and-forget the finalisation gate. If both sides have all 4
    // fields (vibeText + lat/lng each) tryFinalize will run the Places
    // pipeline and send the scheduled DM. If not, it's a cheap no-op.
    void tryFinalize(api, matchId).catch((err) => {
      console.warn(`[location/select] tryFinalize failed for ${matchId}:`, err);
    });

    res.status(200).json({ ok: true });
  });

  return router;
}

async function authenticatedUser(
  req: Request,
  res: Response,
): Promise<{ id: string; telegramId: bigint } | null> {
  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(401).json(auth.body);
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(auth.user.id) },
    select: { id: true, telegramId: true },
  });
  if (!user) {
    res.status(404).json({ error: "user-not-found" });
    return null;
  }
  return user;
}

type AuthOk = { ok: true; user: { id: number } };
type AuthErr = { ok: false; body: { error: string; reason?: string } };

function authenticate(req: Request): AuthOk | AuthErr {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, body: { error: "Missing tma initData" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) {
    return { ok: false, body: { error: "Empty initData" } };
  }
  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, body: { error: "Invalid initData", reason: validation.reason } };
  }
  return { ok: true, user: { id: validation.user.id } };
}

interface PlacesV1Place {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

async function searchText(
  apiKey: string,
  query: string,
  bias: { lat: number; lng: number } | null,
): Promise<PlaceSearchHit[]> {
  const body: Record<string, unknown> = { textQuery: query };
  if (bias) {
    body.locationBias = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        // 5km bias radius — far enough to surface near-by transit stops
        // and landmarks, narrow enough to keep "metro" disambiguated to
        // the user's city rather than every metro globally.
        radius: 5000,
      },
    };
  }
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Places searchText failed: ${res.status}`);
  }
  const json = (await res.json()) as { places?: PlacesV1Place[] };
  const hits: PlaceSearchHit[] = [];
  for (const p of json.places ?? []) {
    const name = p.displayName?.text;
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    if (!name || lat == null || lng == null) continue;
    hits.push({
      placeId: p.id,
      name,
      address: p.formattedAddress ?? "",
      lat,
      lng,
    });
  }
  return hits.slice(0, 8);
}

/**
 * Fallback for local dev when no PLACES_API_KEY is set. Returns one
 * deterministic hit so the Mini App's autocomplete pipeline can be
 * exercised without hitting Google.
 */
function stubResults(query: string): PlaceSearchHit[] {
  return [
    {
      placeId: undefined,
      name: `${query} (stub)`,
      address: "Local dev stub — set PLACES_API_KEY for real results",
      lat: 50.4501,
      lng: 30.5234,
    },
  ];
}
