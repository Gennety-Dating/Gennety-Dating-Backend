import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { locationSearchLimiter } from "../rate-limit.js";
import {
  tryFinalize,
  sendVenuePostSaveAck,
} from "../../handlers/matching/venue-negotiation.js";
import { startPeerWaitShimmer } from "../../services/peer-wait.js";
import { recordMiniAppAction } from "../../services/chat-events.js";
import {
  confirmVenueIntent,
  getVenueIntentState,
  interpretVenueIntent,
  venueIntentMode,
  type ConfirmVenueIntentInput,
} from "../../services/venue-intent-v2.js";
import {
  assertDepartureOrigin,
  checkDepartureOrigin,
  isVenueOriginRefusal,
  resolveDepartureMarket,
  venueOriginRefusal,
} from "../../services/venue-origin.js";
import { readPlaceCache, writePlaceCache } from "../../services/place-cache.js";
import type { Market } from "@gennety/shared";

/**
 * Location Mini App endpoints (Phase 3.7 — concierge venue, map picker).
 *
 *   GET  /v1/location/search   — proxy to Places **Autocomplete (New)**, so the
 *                                user can type "Lukyanivska metro" or
 *                                "Khreshchatyk 14" and pick a real place.
 *   GET  /v1/location/resolve  — turns the picked prediction into coordinates
 *                                (Place Details), closing the autocomplete
 *                                session. Cached by `place_id`.
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
 *
 * ## Why two endpoints where there used to be one (2026-09-04)
 *
 * The picker used to answer every debounced keystroke with a full Places
 * **Text Search**, which is billed per request at the Pro tier — for search
 * endpoints, `location` and `formattedAddress` are Pro fields, so there is no
 * cheaper mask that still returns something usable. Typing one address cost
 * three to six of those; a single departure point ran $0.10–$0.19.
 *
 * Autocomplete is the endpoint built for the per-keystroke case, and it is an
 * order of magnitude cheaper on its own. It is FREE when the requests form a
 * session: the same `sessionToken` on every autocomplete call and on the Place
 * Details call that ends it moves them to the zero-cost "Autocomplete Session
 * Usage" SKU. So the whole episode now costs one Place Details **Essentials**
 * request — `id`, `location`, `formattedAddress` and nothing above them — which
 * is where the ~20× saving comes from.
 *
 * The token is minted by the CLIENT, once per typing episode, because that is
 * the boundary Google's session is defined by (the keystrokes that led to one
 * choice) and the server has no way to see it. A reused token is billed as if
 * absent, so the client discards it after a resolve.
 *
 * The cost of the split is that a prediction carries no coordinates — hence
 * `/resolve`, and hence the market check moving there. It is one extra round
 * trip on the tap, against several saved during the typing.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One row the picker can show.
 *
 * `lat`/`lng` are OPTIONAL, and that is the whole shape change of the
 * autocomplete switch: a prediction knows what a place is called and where to
 * look it up, not where it is. A hit without coordinates is resolved through
 * `/resolve` when the user taps it. The legacy Text Search branch still fills
 * them, so an older Mini App bundle keeps working unchanged.
 */
interface PlaceSearchHit {
  placeId: string | undefined;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}

/**
 * Autocomplete session token: a client-minted UUID v4.
 *
 * Validated rather than trusted because it is forwarded to Google verbatim. A
 * malformed token would be rejected upstream, and a rejected autocomplete looks
 * exactly like "no results" to the user — the same silent-failure shape the
 * `locationRestriction` rectangle bug had (see `searchText`).
 */
const SESSION_TOKEN_REGEX = UUID_REGEX;

/** Google's ceiling for a `circle` radius in Autocomplete / Nearby requests. */
const MAX_CIRCLE_RADIUS_M = 50_000;

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
    // A pin outside the user's launched market is refused with its own reason,
    // never as `wrong-state` — the Mini App turns it into the on-screen block
    // card naming the city (PRODUCT_SPEC §3.7).
    if (isVenueOriginRefusal(intent)) {
      res.status(400).json(intent);
      return;
    }
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
    // Telegram Mini App: respond as soon as the confirmation is persisted and
    // let the selector run in the background. The Mini App closes on this ack,
    // and the concierge narrates the search with its chat status shimmer before
    // the date card lands — instead of the user staring at a spinning button in
    // a web view that used to stay open for the whole selection.
    const state = await confirmVenueIntent(matchId, actor.id, intent, { awaitFinalization: false });
    if (isVenueOriginRefusal(state)) {
      res.status(400).json(state);
      return;
    }
    if (!state) {
      res.status(409).json({ error: "draft-not-found" });
      return;
    }
    // Telegram chat cue: finalization only runs once BOTH sides have confirmed
    // (tryFinalizeVenueIntentV2 returns early otherwise). If the partner hasn't
    // confirmed yet, the actor gets the waiting SHIMMER — no chat message any
    // more (PRODUCT_SPEC §3.6b) — held by `workers/peer-wait-shimmer.ts` until
    // the partner confirms. When the partner HAS confirmed, finalize already
    // delivered the scheduled confirmation (date card), so there is no wait.
    // Telegram-only route (not the shared confirmVenueIntent service) so the
    // iOS path, which has its own waiting UI, is never touched.
    recordMiniAppAction(
      actor.telegramId,
      state.partnerSubmitted
        ? "in the venue Mini App, confirmed their departure point and vibe — both sides are in, the concierge is picking the place"
        : "in the venue Mini App, confirmed their departure point and vibe (waiting on their partner)",
      { surface: "venue_intent", matchId },
    );
    if (!state.partnerSubmitted) {
      startPeerWaitShimmer(api, matchId, { userId: actor.id });
    }
    res.json({ ok: true, ...state });
  });

  router.get("/search", locationSearchLimiter, async (req: Request, res: Response): Promise<void> => {
    // Resolves the DB user (not just the Telegram id) because the search is
    // restricted to the caller's own market below.
    const actor = await authenticatedUser(req, res);
    if (!actor) return;

    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2) {
      res.status(200).json({ ok: true, results: [] });
      return;
    }
    if (query.length > 120) {
      res.status(400).json({ error: "Query is too long" });
      return;
    }
    // The market is a HARD restriction, not a bias (PRODUCT_SPEC §3.7). A bias
    // only reorders, so "Berlin Hauptbahnhof" still came back and could still be
    // picked and saved — the block card would then have to explain a result the
    // search had just offered. Restricting instead means an out-of-market place
    // is simply not on the screen. Falls back to the caller's map centre as a
    // plain bias when we cannot resolve their market (a legacy account), which
    // is the old behaviour.
    const market = await resolveDepartureMarket(actor.id);
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

    // The client mints one token per typing episode and sends it with every
    // keystroke, which is what makes the episode a billable-as-free session.
    // Its ABSENCE is also the version signal: a Mini App bundle predating
    // 2026-09-04 does not send one and needs coordinates in the response, so it
    // keeps the old Text Search path. Retire that branch — and this comment —
    // once no such bundle can still be cached (the Caddy `no-cache` rule on
    // `*.html` bounds that to a single session).
    const session = typeof req.query.session === "string" ? req.query.session : "";

    try {
      if (session && SESSION_TOKEN_REGEX.test(session)) {
        const results = await autocomplete(
          apiKey,
          query,
          session,
          hasBias ? { lat, lng } : null,
          market,
          actor.language,
        );
        res.status(200).json({ ok: true, results });
        return;
      }
      const results = await searchText(
        apiKey,
        query,
        hasBias ? { lat, lng } : null,
        market,
      );
      res.status(200).json({ ok: true, results });
    } catch (err) {
      console.warn("[location/search] Places lookup failed:", err);
      // 502, NOT an empty 200. An empty list is a real answer here — the market
      // restriction makes "nothing matches" the correct response to plenty of
      // what gets typed in a launched city — so answering an upstream failure
      // with one leaves the caller no way to tell a miss from an outage, and
      // the picker then cannot say which happened either. That is how a Places
      // key whose API restrictions stopped listing Places API (New) — 403
      // PERMISSION_DENIED on every call, found 2026-09-07 — read on screen as
      // "the search just never finds anything", for as long as it did.
      //
      // The picker still soft-fails on this: no modal, the map is untouched,
      // the point can still be dropped by hand. It only stops being silent.
      res.status(502).json({ error: "search-unavailable" });
    }
  });

  // GET /resolve?placeId=<id>&session=<uuid>
  //
  // The second half of one autocomplete session: the user tapped a prediction,
  // and a prediction carries no coordinates. Passing the SAME `session` token
  // Google saw on the keystrokes is what closes the session and makes those
  // keystrokes free, so the token is required here rather than optional.
  //
  // Answered from `place_cache` whenever we already know the place — which, in
  // a single launched city, is most of the time: a departure point is a metro
  // station or a campus, and the same few dozen are picked over and over. A hit
  // costs nothing and closes no session, which is correct: there was no
  // upstream session to close, because there were no billed keystrokes to
  // absolve. Google bills an unclosed session's requests individually, and at
  // Autocomplete's own price that is still ~11× under a Text Search.
  router.get("/resolve", locationSearchLimiter, async (req: Request, res: Response): Promise<void> => {
    const actor = await authenticatedUser(req, res);
    if (!actor) return;

    const placeId = typeof req.query.placeId === "string" ? req.query.placeId.trim() : "";
    // Places ids are opaque, so the only safe validation is shape + length: it
    // goes into a URL path segment, and an unbounded one is a request we would
    // pay for on a caller's whim.
    if (!placeId || placeId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(placeId)) {
      res.status(400).json({ error: "invalid-place-id" });
      return;
    }
    const session = typeof req.query.session === "string" ? req.query.session : "";

    const apiKey = process.env.PLACES_API_KEY;

    // A cached row without coordinates is not a hit: the picker's whole reason
    // for calling this is the pin. Such a row exists whenever the photo path
    // wrote the place first (`photoRefs` only), so it must fall through to
    // Google rather than resolve to nothing.
    const cached = await readPlaceCache(placeId);
    let hit: PlaceSearchHit | null =
      cached && cached.lat != null && cached.lng != null
        ? {
            placeId,
            name: cached.name ?? "",
            address: cached.address ?? "",
            lat: cached.lat,
            lng: cached.lng,
          }
        : null;

    if (!hit) {
      if (!apiKey) {
        // Dev parity with `stubResults`: no key, no lookup, one fixed point so
        // the picker still advances.
        res.status(200).json({
          ok: true,
          result: { placeId, name: "Stub place", address: "Local dev stub", lat: 50.4501, lng: 30.5234 },
        });
        return;
      }
      try {
        hit = await fetchPlaceEssentials(
          apiKey,
          placeId,
          session && SESSION_TOKEN_REGEX.test(session) ? session : null,
        );
      } catch (err) {
        console.warn(`[location/resolve] Place Details failed for ${placeId}:`, err);
        res.status(502).json({ error: "upstream" });
        return;
      }
      if (!hit || hit.lat == null || hit.lng == null) {
        res.status(404).json({ error: "place-not-found" });
        return;
      }
      // `name` is deliberately CONDITIONAL. Place Details is asked at the
      // Essentials tier, which carries no `displayName`, so `hit.name` here is
      // always `""` — and `writePlaceCache` only skips `undefined`, not an
      // empty string, so writing it unconditionally would overwrite a real
      // cached name with a blank one (the photo path stores a name; the board
      // and any future reader would then have none). Omitting the key leaves
      // that column untouched, which is exactly the "a resolve cannot blank
      // the photo refs" symmetry `place-cache.ts` documents.
      await writePlaceCache(placeId, {
        ...(hit.name ? { name: hit.name } : {}),
        address: hit.address,
        lat: hit.lat,
        lng: hit.lng,
      });
    }

    // The market gate moves here from the search response filter: a prediction
    // has no coordinates, so this is the first moment the question can be
    // asked. Autocomplete was already restricted to the market's circle, so
    // this is agreement rather than a second opinion — and it is the same
    // circular test `assertDepartureOrigin` applies on the write, which is what
    // keeps the picker from offering a place Confirm would then refuse.
    const market = await resolveDepartureMarket(actor.id);
    if (market && !checkDepartureOrigin(market, hit.lat!, hit.lng!).ok) {
      res.status(400).json(venueOriginRefusal(market));
      return;
    }

    res.status(200).json({ ok: true, result: hit });
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

    // The departure-point gate (PRODUCT_SPEC §3.7). Same refusal shape as the
    // V2 confirm above, so an older Mini App bundle — which still saves through
    // this route — gets a reason it can render instead of a silent write.
    const gate = await assertDepartureOrigin(user.id, lat, lng);
    if (!gate.ok) {
      res.status(400).json(venueOriginRefusal(gate.market));
      return;
    }

    await prisma.match.update({
      where: { id: matchId },
      data: isA
        ? { vibeLatA: lat, vibeLngA: lng, vibeAddressA: address }
        : { vibeLatB: lat, vibeLngB: lng, vibeAddressB: address },
    });

    recordMiniAppAction(
      auth.user.id,
      address
        ? `in the venue Mini App, marked their departure point: ${address}`
        : "in the venue Mini App, marked their departure point on the map",
      { surface: "venue_intent", matchId },
    );

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
): Promise<{ id: string; telegramId: bigint; language: Language | null } | null> {
  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(401).json(auth.body);
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(auth.user.id) },
    select: { id: true, telegramId: true, language: true },
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

/** Degrees of latitude per km — the meridian is the one axis with a constant scale. */
const KM_PER_DEGREE_LAT = 111.32;

/**
 * The smallest lat/lng box containing the market's circle.
 *
 * Places wants a rectangle (see `searchText`) while a market is a centroid
 * plus a radius, so the box necessarily over-includes at the corners; the
 * per-result `checkDepartureOrigin` filter is what cuts them back to the
 * circle. Over-including is the safe direction — under-including would hide
 * real addresses inside the market.
 */
export function marketBoundingBox(market: Market): {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
} {
  const dLat = market.radiusKm / KM_PER_DEGREE_LAT;
  // Meridians converge toward the poles, so a km buys more longitude the
  // further north you are. Kyiv sits at ~50°, where the box is over half again
  // as wide as it is tall; using dLat for both would cut ~36% off each side.
  const cos = Math.cos((market.latitude * Math.PI) / 180);
  const dLng = market.radiusKm / (KM_PER_DEGREE_LAT * Math.max(cos, 0.01));
  return {
    low: {
      latitude: Math.max(market.latitude - dLat, -90),
      longitude: Math.max(market.longitude - dLng, -180),
    },
    high: {
      latitude: Math.min(market.latitude + dLat, 90),
      longitude: Math.min(market.longitude + dLng, 180),
    },
  };
}

interface AutocompleteResponse {
  suggestions?: {
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }[];
}

/**
 * Places **Autocomplete (New)**, restricted to the caller's launched market.
 *
 * Three things make this the cheap path:
 *
 *  - It is the per-keystroke endpoint, priced accordingly.
 *  - `sessionToken` ties the keystrokes to the `/resolve` call that follows, and
 *    a closed session's autocomplete requests are billed at zero.
 *  - There is no field mask to get wrong: a prediction is a name and an id, so
 *    there is no way to accidentally buy an Enterprise field here.
 *
 * The market is a **circle**, and unlike `searchText` this endpoint accepts one
 * for `locationRestriction` — so the restriction is now the market's real shape
 * rather than a bounding box that has to be trimmed per result. That removes
 * the corner-overshoot the old path had to filter out, and it is why the
 * remaining market check lives on `/resolve` instead of here.
 *
 * `includeQueryPredictions` stays off (its default): a query prediction has no
 * `placeId`, so it could not be resolved into a departure point and would be a
 * row that does nothing when tapped.
 */
async function autocomplete(
  apiKey: string,
  query: string,
  sessionToken: string,
  bias: { lat: number; lng: number } | null,
  market: Market | null,
  language: Language | null,
): Promise<PlaceSearchHit[]> {
  const body: Record<string, unknown> = { input: query, sessionToken };
  if (language) body.languageCode = language;
  if (market) {
    body.locationRestriction = {
      circle: {
        center: { latitude: market.latitude, longitude: market.longitude },
        radius: Math.min(market.radiusKm * 1000, MAX_CIRCLE_RADIUS_M),
      },
    };
    body.regionCode = market.countryCode;
  } else if (bias) {
    body.locationBias = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        // Same 5km as the old bias: wide enough to surface nearby transit stops
        // and landmarks, narrow enough to keep "metro" in the user's city.
        radius: 5000,
      },
    };
  }
  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Places autocomplete failed: ${res.status}`);
  }
  const json = (await res.json()) as AutocompleteResponse;
  const hits: PlaceSearchHit[] = [];
  for (const suggestion of json.suggestions ?? []) {
    const prediction = suggestion.placePrediction;
    // No id means nothing to resolve — a query prediction, or a malformed row.
    if (!prediction?.placeId) continue;
    const main = prediction.structuredFormat?.mainText?.text;
    const secondary = prediction.structuredFormat?.secondaryText?.text;
    const name = main ?? prediction.text?.text;
    if (!name) continue;
    hits.push({
      placeId: prediction.placeId,
      name,
      // The structured secondary line IS the address line the picker showed
      // from `formattedAddress` before, and it arrives here for free.
      address: secondary ?? "",
    });
  }
  return hits.slice(0, 8);
}

/**
 * Place Details for one prediction, at the **Essentials** tier and no higher.
 *
 * The mask is exactly what the picker needs to drop a pin and store an origin:
 * `id`, `location`, `formattedAddress`. On Place Details those are Essentials
 * fields — `displayName` would have pushed the request to Pro for a string the
 * autocomplete prediction already gave us, which is precisely the kind of
 * accidental tier bump this whole change exists to remove.
 *
 * `sessionToken` rides along when the caller has one: it is what marks the
 * preceding autocomplete requests as a completed session and drops their cost
 * to zero. Passing a token that was already spent is billed as if none were
 * sent, so a cache hit correctly sends nothing.
 */
async function fetchPlaceEssentials(
  apiKey: string,
  placeId: string,
  sessionToken: string | null,
): Promise<PlaceSearchHit | null> {
  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
  if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "id,location,formattedAddress",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Places place details failed: ${res.status}`);
  }
  const place = (await res.json()) as PlacesV1Place;
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (lat == null || lng == null) return null;
  return {
    placeId: place.id ?? placeId,
    // Essentials carries no display name — the picker already has the
    // prediction's text, and buying the name again would cost the Pro tier.
    name: "",
    address: place.formattedAddress ?? "",
    lat,
    lng,
  };
}

/**
 * LEGACY per-keystroke Text Search — Pro tier, billed per request.
 *
 * Reached only by a Mini App bundle from before 2026-09-04, which does not send
 * a session token and cannot resolve a coordinate-less prediction. Kept solely
 * so a cached bundle keeps working through one session; `autocomplete` above is
 * the live path. Delete this together with the `session`-absent branch in
 * `/search`.
 */
async function searchText(
  apiKey: string,
  query: string,
  bias: { lat: number; lng: number } | null,
  market: Market | null,
): Promise<PlaceSearchHit[]> {
  const body: Record<string, unknown> = { textQuery: query };
  if (market) {
    // Hard restriction to the launched market: Places is told not to return
    // anything outside it, so an out-of-market address is never offered in the
    // first place (PRODUCT_SPEC §3.7).
    //
    // It MUST be a rectangle. `searchText` accepts a circle for
    // `locationBias` but not for `locationRestriction`, and it does not
    // degrade to an unrestricted search — it answers
    // `400 INVALID_ARGUMENT: Unknown name "circle"`, which the caller's catch
    // then reports as an empty result list. That is how a circle here made the
    // Mini App's search look like it simply found nothing, for every user in a
    // launched market, from the day the gate shipped (2026-08-05) until
    // 2026-08-09.
    body.locationRestriction = { rectangle: marketBoundingBox(market) };
  } else if (bias) {
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
    // The restriction is a rectangle and the market is a circle, so the box's
    // corners reach past it. This is what trims them back, which is what keeps
    // the offered results and the write gate (`assertDepartureOrigin`, also
    // circular) in agreement — otherwise the search could put a place on the
    // screen that Confirm would then refuse.
    if (market && !checkDepartureOrigin(market, lat, lng).ok) continue;
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
