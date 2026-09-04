import { gzip } from "node:zlib";
import { promisify } from "node:util";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { allowCrossOriginImage } from "./cross-origin-image.js";
import { stripUndrawnLayers } from "./vector-tile-filter.js";
import type { Api, RawApi } from "grammy";
import { env } from "../config.js";
import {
  globalLimiter,
  mapTileLimiter,
} from "./rate-limit.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { assistantRouter } from "./routes/assistant.js";
import { chatRouter } from "./routes/chat.js";
import { matchesRouter } from "./routes/matches.js";
import { matchMediaRouter } from "./routes/match-media.js";
import { countdownRouter } from "./routes/countdown.js";
import { dateStateRouter } from "./routes/date-state.js";
import { eventsPublicRouter } from "./routes/events.js";
import { gatekeeperRouter } from "./routes/gatekeeper.js";
import { dateBumpRouter } from "./routes/date-bump.js";
import { dateRadarRouter } from "./routes/date-radar.js";
import { scratchMapRouter } from "./routes/scratch-map.js";
import { appConfigRouter } from "./routes/app-config.js";
import { phoneAuthRouter } from "./routes/phone-auth.js";
import { telegramAuthRouter } from "./routes/telegram-auth.js";
import { liveActivityRouter } from "./routes/live-activity.js";
import { accountStatusRouter } from "./routes/account-status.js";
import { ticketsAppStoreRouter } from "./routes/tickets-appstore.js";
import { premiumAppStoreRouter } from "./routes/premium-appstore.js";
import { clientEventsRouter } from "./routes/client-events.js";
import { appStoreWebhookRouter } from "./routes/appstore-webhook.js";
import { founderReportRouter } from "./routes/founder-report.js";
import { verificationRouter } from "./routes/verification.js";
import { createCalendarRouter } from "./routes/calendar.js";
import { createFeedbackRouter } from "./routes/feedback.js";
import { createLocationRouter } from "./routes/location.js";
import { createTelegramOnboardingRouter } from "./routes/telegram-onboarding.js";
import { createVerificationMiniAppRouter } from "./routes/verification-mini-app.js";
import { createTicketRouter } from "./routes/ticket.js";
import { createNativeTicketGateRouter } from "./routes/ticket-gate.js";
import { createNativeCalendarRouter } from "./routes/calendar-native.js";
import { createProxyChatRouter } from "./routes/proxy-chat.js";
import { createUserBlocksRouter } from "./routes/user-blocks.js";
import { ticketsHistoryRouter } from "./routes/tickets-history.js";
import { createVoicePromptRouter } from "./routes/voice-prompt.js";
import { createNativeFeedbackRouter } from "./routes/feedback-native.js";
import { createTicketStoreRouter } from "./routes/tickets.js";
import { createRadarRouter } from "./routes/radar.js";
import { createVenueChangeRouter } from "./routes/venue-change.js";
import { createPremiumRouter } from "./routes/premium.js";
import { createReferralRouter } from "./routes/referral.js";
import { createPromoRouter } from "./routes/promo.js";
import {
  isStrongJwtSecret,
  JWT_SECRET_MIN_BYTES,
} from "./jwt.js";

/**
 * Public `/v1/*` HTTP API consumed by the Expo mobile app.
 *
 * This is a second Express instance running alongside `admin/server.ts`.
 * It intentionally has a different CORS policy (app-origin or wildcard for
 * native clients), per-route rate limits, and a JWT bearer auth scheme —
 * none of which match the admin API's `ADMIN_API_KEY` model.
 *
 * Routers are registered in phases:
 *   Phase 2 → /v1/auth, /v1/me
 *   Phase 3 → /v1/onboarding, /v1/assistant
 *   Phase 4 → /v1/matches, /v1/countdown
 *   Phase 5 → /v1/me/verification, /v1/me/verify-selfie, push
 */
export const app: ReturnType<typeof express> = express();

app.set("trust proxy", 1);

app.use(helmet());
// Public API auth is header-based (Bearer JWT / Telegram `tma` initData), never
// cookie-based, so a wildcard ACAO is not a credential-leak vector — but an
// unset origin now DENIES cross-origin browser requests (audit L3, mirroring the
// admin surface) instead of silently wildcarding, and an explicit `*` warns.
// Native mobile clients send no `Origin` header, so CORS never applies to them
// regardless of this setting.
let publicCorsOrigin: string | string[] | boolean;
if (env.PUBLIC_CORS_ORIGIN === "*") {
  publicCorsOrigin = "*";
  console.warn(
    "[public] PUBLIC_CORS_ORIGIN is '*' — any browser origin may call /v1/*. " +
      "Set it to the concrete Mini App / web signup origins in production.",
  );
} else if (env.PUBLIC_CORS_ORIGIN) {
  publicCorsOrigin = env.PUBLIC_CORS_ORIGIN.split(",");
} else {
  publicCorsOrigin = false;
  console.warn(
    "[public] PUBLIC_CORS_ORIGIN is unset — cross-origin browser requests are denied. " +
      "Set it to the Mini App / web signup origins to enable browser access.",
  );
}
app.use(
  cors({
    origin: publicCorsOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  }),
);
// The bot Api is injected lazily (see `startPublicServer`) because importing
// `./bot.js` here would cycle with `./index.ts`. Until wired, the routers that
// need it answer 503.
let injectedBotApi: Api<RawApi> | null = null;
let calendarRouter: ReturnType<typeof createCalendarRouter> | null = null;
let feedbackRouter: ReturnType<typeof createFeedbackRouter> | null = null;
let locationRouter: ReturnType<typeof createLocationRouter> | null = null;
let telegramOnboardingRouter: ReturnType<typeof createTelegramOnboardingRouter> | null = null;
let verificationMiniAppRouter: ReturnType<typeof createVerificationMiniAppRouter> | null = null;
let ticketRouter: ReturnType<typeof createTicketRouter> | null = null;
let nativeTicketGateRouter: ReturnType<typeof createNativeTicketGateRouter> | null = null;
let nativeCalendarRouter: ReturnType<typeof createNativeCalendarRouter> | null = null;
let proxyChatRouter: ReturnType<typeof createProxyChatRouter> | null = null;
let voicePromptRouter: ReturnType<typeof createVoicePromptRouter> | null = null;
let nativeFeedbackRouter: ReturnType<typeof createNativeFeedbackRouter> | null = null;
let ticketStoreRouter: ReturnType<typeof createTicketStoreRouter> | null = null;
let radarRouter: ReturnType<typeof createRadarRouter> | null = null;
let venueChangeRouter: ReturnType<typeof createVenueChangeRouter> | null = null;
let premiumRouter: ReturnType<typeof createPremiumRouter> | null = null;
let referralRouter: ReturnType<typeof createReferralRouter> | null = null;
// Public map-tile proxy for the two map Mini App screens (the departure-point
// picker and the Living Canvas). Some client networks can't reach the tile CDN
// directly (regional CDN blocks), so the bot fetches tiles server-side and
// streams them — the phone only ever talks to our own origin, which it already
// reaches to load the Mini App. Tiles are public + immutable → no auth,
// aggressive cache. There is a dedicated higher-volume limiter because one map
// view fetches ~10 tiles at once, but it is never an unbounded proxy.
//
// Two routes, because the basemap moved from raster PNG to vector:
//   /v1/vectortiles — the live one (`.mvt`, MapLibre), needs no CARTO key.
//   /v1/maptiles    — the legacy raster one, kept only for Mini App bundles
//                     cached on a phone from before the migration.
const TILE_SUBDOMAINS = ["a", "b", "c", "d"] as const;
const MAX_TILE_BYTES = 1024 * 1024;

/** Validated `{z}/{x}/{y}`, or null. The bounds check is what stops the proxy
    being pointed at an arbitrary upstream path. */
function tileCoords(req: Request): { z: number; x: number; y: number } | null {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const valid =
    Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) &&
    z >= 0 && z <= 22 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
  return valid ? { z, x, y } : null;
}

/**
 * Read an upstream tile with a hard size ceiling.
 *
 * The ceiling is enforced while STREAMING rather than from `content-length`,
 * and on the vector route that is not belt-and-braces: CARTO serves `.mvt`
 * gzipped, Node's `fetch` transparently decompresses it, and the
 * `content-length` header still describes the COMPRESSED bytes — so the header
 * under-reports the body by ~1.7x and cannot be the guard. Measured worst case
 * over central Kyiv at z14 is 448 KB decompressed, i.e. 2.3x headroom.
 */
async function readTile(upstream: string): Promise<Buffer | null> {
  const upstreamRes = await fetch(upstream, { signal: AbortSignal.timeout(8000) });
  if (!upstreamRes.ok || !upstreamRes.body) return null;
  const reader = upstreamRes.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_TILE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
}

const gzipAsync = promisify(gzip);

app.get("/v1/vectortiles/:z/:x/:y", mapTileLimiter, async (req, res) => {
  const coords = tileCoords(req);
  if (!coords) {
    res.status(400).end();
    return;
  }
  const { z, x, y } = coords;
  const sub = TILE_SUBDOMAINS[(x + y) % TILE_SUBDOMAINS.length];
  // `carto.streets/v1` is the source behind CARTO's own GL styles, and it needs
  // NO api key — which is the whole reason the map moved here from the raster
  // basemap. The style that reads it is vendored client-side in
  // `apps/webapp/src/map-style.ts`; it declares no glyphs and no sprite, so
  // this is the ONLY upstream URL the map touches and the proxy stays a
  // single-origin one.
  const upstream =
    `https://tiles-${sub}.basemaps.cartocdn.com/vectortiles/carto.streets/v1/${z}/${x}/${y}.mvt`;
  try {
    const raw = await readTile(upstream);
    if (!raw) {
      res.status(502).end();
      return;
    }
    // Two steps, innermost first.
    //
    // Drop the label/POI layers this style never draws. 78% of a central-Kyiv
    // z14 tile is layers we do not render, which is the difference between a
    // ~1 MB screen and a ~342 KB one — see `vector-tile-filter.ts` for the
    // measurements and for why it cannot corrupt a tile.
    //
    // Then re-compress what `fetch` decompressed on the way in. Not optional:
    // the phones this proxy exists for are on the worst networks, and
    // forwarding the plain protobuf would send them ~1.7x the bytes CARTO
    // would have. Measured, our output lands within ~0.5% of CARTO's own gzip,
    // at 0.7–17.5 ms per tile — and `zlib.gzip` is async, so that cost sits on
    // the libuv threadpool rather than blocking the bot's event loop.
    const body = await gzipAsync(stripUndrawnLayers(raw));
    res.setHeader("Content-Type", "application/x-protobuf");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    allowCrossOriginImage(res);
    res.status(200).end(body);
  } catch {
    res.status(502).end();
  }
});

app.get("/v1/maptiles/:z/:x/:y", mapTileLimiter, async (req, res) => {
  const coords = tileCoords(req);
  if (!coords) {
    res.status(400).end();
    return;
  }
  const { z, x, y } = coords;
  const sub = TILE_SUBDOMAINS[(x + y) % TILE_SUBDOMAINS.length];
  // LEGACY. Kept alive only so a Mini App bundle cached before the vector
  // migration keeps drawing a map; nothing we ship still requests it.
  //
  // `dark_nolabels` = the dark basemap without place labels. CARTO bakes labels
  // into the raster in the LOCAL language and offers no English variant, so we
  // dropped labels rather than show the wrong one.
  //
  // The key rides server-side (see `CARTO_API_KEY` in config.ts). Unkeyed,
  // CARTO answers 200 with a WATERMARKED PNG rather than an error, so no status
  // check here can catch a missing key — the boot warning in
  // `startPublicServer` is what makes that state visible.
  const upstream =
    `https://${sub}.basemaps.cartocdn.com/dark_nolabels/${z}/${x}/${y}.png` +
    (env.CARTO_API_KEY ? `?key=${encodeURIComponent(env.CARTO_API_KEY)}` : "");
  try {
    const buf = await readTile(upstream);
    if (!buf) {
      res.status(502).end();
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    allowCrossOriginImage(res);
    res.status(200).end(buf);
  } catch {
    res.status(502).end();
  }
});

app.use(globalLimiter);
// Apply the cheap IP limiter before allocating/parsing attacker-controlled JSON.
app.use(express.json({ limit: "512kb" }));

// Calendar Mini App pick endpoint — see routes/calendar.ts for why this can't
// just be a `web_app_data` handler. Mounted AFTER `express.json` so we get a
// parsed body, but BEFORE the JWT-auth routes — auth is by Telegram initData
// signature, not Bearer token.
app.use("/v1/calendar", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Calendar endpoint not ready" });
    return;
  }
  if (!calendarRouter) calendarRouter = createCalendarRouter(injectedBotApi);
  calendarRouter(req, res, next);
});

// Post-date feedback Mini App endpoint — same initData-HMAC auth as
// /v1/calendar; not behind JWT for the same reason (the Mini App has only
// the bot's secret, not a user JWT).
app.use("/v1/feedback", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Feedback endpoint not ready" });
    return;
  }
  if (!feedbackRouter) feedbackRouter = createFeedbackRouter(injectedBotApi);
  feedbackRouter(req, res, next);
});

// Location Mini App — same initData-HMAC auth as /v1/calendar. Surfaces
// Google Places search results to the picker UI so users can type an
// address / metro station instead of (or in addition to) sharing their
// raw GPS pin via Telegram's reply keyboard.
app.use("/v1/location", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Location endpoint not ready" });
    return;
  }
  if (!locationRouter) locationRouter = createLocationRouter(injectedBotApi);
  locationRouter(req, res, next);
});

// Venue change Mini App — female-exclusive one-shot venue swap. Same
// initData-HMAC auth as /v1/calendar & /v1/location. Inert behaviour when
// VENUE_CHANGE_FEATURE_ENABLED is off (endpoints return ineligible).
app.use("/v1/venue-change", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Venue change endpoint not ready" });
    return;
  }
  if (!venueChangeRouter) venueChangeRouter = createVenueChangeRouter(injectedBotApi);
  venueChangeRouter(req, res, next);
});

// Verification Mini App — AWS Face Liveness capture inside the Telegram
// WebView (no redirect anywhere). Same TMA-auth boundary as
// /v1/calendar/* /v1/location/* /v1/feedback/*. Mounted under
// /v1/verification/mini-app to avoid colliding with the JWT-auth
// /v1/me/verification/* mobile routes.
app.use("/v1/verification/mini-app", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Verification mini-app endpoint not ready" });
    return;
  }
  if (!verificationMiniAppRouter) {
    verificationMiniAppRouter = createVerificationMiniAppRouter(injectedBotApi);
  }
  verificationMiniAppRouter(req, res, next);
});

// Full-screen Telegram onboarding Mini App. Same TMA auth boundary as
// calendar/location, but it can also dispatch the first post-handoff bot DM.
app.use("/v1/telegram-onboarding", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Telegram onboarding endpoint not ready" });
    return;
  }
  if (!telegramOnboardingRouter) {
    telegramOnboardingRouter = createTelegramOnboardingRouter(injectedBotApi);
  }
  telegramOnboardingRouter(req, res, next);
});

// Slot calendar for the NATIVE client — the JWT twin of /v1/calendar, which is
// initData-authed and therefore unreachable from the app. Mounted before the
// JWT /v1/matches router, which owns no such sub-path and would 404 it.
app.use("/v1/matches/:matchId/calendar", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Calendar endpoint not ready" });
    return;
  }
  if (!nativeCalendarRouter) nativeCalendarRouter = createNativeCalendarRouter(injectedBotApi);
  nativeCalendarRouter(req, res, next);
});

// Post-date feedback for the NATIVE client. The Mini App twin lives at
// `/v1/feedback` and is initData-signed; this one is JWT and adds the piece
// that surface never needed — discovery. In Telegram the T+24h DM carries the
// link, so nothing has to be asked for; the app has no such carrier, and
// `/v1/matches/current` stops returning the match once it is `completed`.
app.use("/v1/me/feedback", (req, res, next) => {
  if (!nativeFeedbackRouter) nativeFeedbackRouter = createNativeFeedbackRouter();
  nativeFeedbackRouter(req, res, next);
});

// Anonymous pre-date chat for the NATIVE client — the JWT twin of the Telegram
// relay, which is a bot chat session and therefore unreachable from the app.
// Needs no bot API of its own: the service reaches a Telegram partner through
// `getMainBotApi()` and a mobile one through APNs.
app.use("/v1/matches/:matchId/chat", (req, res, next) => {
  if (!env.COORDINATION_FEATURE_ENABLED) {
    res.status(404).json({ error: "coordination-disabled" });
    return;
  }
  if (!proxyChatRouter) proxyChatRouter = createProxyChatRouter();
  proxyChatRouter(req, res, next);
});

// Date Ticket gate for the NATIVE client — same match, JWT auth instead of
// initData, and a wallet-only rail (see routes/ticket-gate.ts). Mounted before
// the Mini App's `/ticket` prefix so route resolution is unambiguous rather
// than a question about how path-to-regexp treats `ticket-gate`.
app.use("/v1/matches/:matchId/ticket-gate", (req, res, next) => {
  if (!env.TICKET_FEATURE_ENABLED) {
    res.status(404).json({ error: "tickets-disabled" });
    return;
  }
  if (!injectedBotApi) {
    res.status(503).json({ error: "Ticket endpoint not ready" });
    return;
  }
  if (!nativeTicketGateRouter) nativeTicketGateRouter = createNativeTicketGateRouter(injectedBotApi);
  nativeTicketGateRouter(req, res, next);
});

// Date Ticket Mini App — REST-nested under the match but TMA-authed (same
// initData-HMAC boundary as /v1/calendar). Mounted BEFORE the JWT-gated
// /v1/matches router so this more-specific prefix wins for ticket sub-routes.
app.use("/v1/matches/:matchId/ticket", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Ticket endpoint not ready" });
    return;
  }
  if (!ticketRouter) ticketRouter = createTicketRouter(injectedBotApi);
  ticketRouter(req, res, next);
});

// StoreKit 2 purchase reporting (native app, JWT auth) — must be mounted
// BEFORE the generic initData-authed /v1/tickets router so the more-specific
// prefix wins. App Store Server Notifications V2 land on /v1/webhooks.
app.use("/v1/tickets/appstore", ticketsAppStoreRouter);
app.use("/v1/webhooks/appstore", appStoreWebhookRouter);

// Ticket store / wallet Mini App — TMA-authed, feature-flagged. No bot api
// needed (no DMs), so it doesn't depend on injectedBotApi.
app.use("/v1/tickets", (req, res, next) => {
  if (!env.TICKET_FEATURE_ENABLED) {
    res.status(404).json({ error: "tickets-disabled" });
    return;
  }
  if (!ticketStoreRouter) ticketStoreRouter = createTicketStoreRouter();
  ticketStoreRouter(req, res, next);
});

// Type Radar Mini App — TMA-authed, feature-flagged (routes 404 when
// TYPE_RADAR_ENABLED is off). The bot api is optional: deck/submit work without
// it; when present, submit resumes the onboarding conversation past the gate.
app.use("/v1/radar", (req, res, next) => {
  if (!radarRouter) radarRouter = createRadarRouter(injectedBotApi);
  radarRouter(req, res, next);
});

// StoreKit 2 Premium subscription reporting (native app, JWT auth) — mounted
// BEFORE the generic initData-authed /v1/premium router so this more-specific
// prefix wins. App Store Server Notifications V2 land on /v1/webhooks/appstore.
app.use("/v1/premium/appstore", premiumAppStoreRouter);

// Клиентская воронка нативного приложения (iOS 6.2) — JWT необязателен,
// потому что половина событий случается до того, как аккаунт существует.
// Флаг по умолчанию выключен: см. `config.ts → CLIENT_EVENTS_ENABLED`.
app.use("/v1/client", clientEventsRouter);

// Gennety Premium Mini App — TMA-authed, feature-flagged. The invoice mint
// pulls the bot api via getBotApi() at request time, so no injection here.
app.use("/v1/premium", (req, res, next) => {
  if (!env.PREMIUM_FEATURE_ENABLED) {
    res.status(404).json({ error: "premium-disabled" });
    return;
  }
  if (!premiumRouter) premiumRouter = createPremiumRouter();
  premiumRouter(req, res, next);
});

// Referral Mini App — TMA-authed (except the public signed GET /card image that
// Telegram fetches to render the shared photo), feature-flagged.
app.use("/v1/referral", (req, res, next) => {
  if (!env.REFERRAL_FEATURE_ENABLED) {
    res.status(404).json({ error: "referral-disabled" });
    return;
  }
  if (!referralRouter) referralRouter = createReferralRouter();
  referralRouter(req, res, next);
});

// Liveness/readiness probe — unauthenticated, intentionally cheap.
app.get("/v1/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// Pre-auth mobile bootstrap: forced-update kill switch + client feature flags.
// Unauthenticated by design (see routes/app-config.ts); globalLimiter applies.
app.use("/v1/app", appConfigRouter);

// Promo landing + iOS deferred-attribution recorder (PROMO_CODES_PRODUCT_SPEC.md).
// Pre-install / pre-auth by design (the visitor has no account yet); 404 when
// the feature is off. The in-app claim endpoints live on the JWT /v1/me router.
app.use("/v1/promo", createPromoRouter());

// Native-app phone rail (Registration v2 general track) — Gateway/Twilio
// fork, 404 while PHONE_AUTH_ENABLED is off. Mounted before the generic
// /v1/auth router so the more-specific prefix wins.
app.use("/v1/auth/phone", phoneAuthRouter);
// Mounted before the generic auth router so `/v1/auth/telegram` resolves here.
app.use("/v1/auth", telegramAuthRouter);
app.use("/v1/auth", authRouter);
// Voice prompts for the native client (VOICE_PROMPT_PRODUCT_SPEC.md §4.2).
// Same more-specific-prefix rule as the two mounts below. 404s while the
// feature is off, which is also what tells an older client to hide the step.
app.use("/v1/me/voice-prompt", (req, res, next) => {
  if (!env.VOICE_PROMPT_ENABLED) {
    res.status(404).json({ error: "voice-prompt-disabled" });
    return;
  }
  if (!voicePromptRouter) voicePromptRouter = createVoicePromptRouter();
  voicePromptRouter(req, res, next);
});

// Mount /v1/me/verification BEFORE /v1/me so Express tries the more-specific
// prefix first — both routers match `/v1/me/verification/*` otherwise.
app.use("/v1/me/verification", verificationRouter);
// Live Activity token registration (same more-specific-prefix rule).
app.use("/v1/me/live-activity-token", liveActivityRouter);
// Blocked-users list (6.8). Same more-specific-prefix rule as the mounts above.
app.use("/v1/me/blocks", createUserBlocksRouter());
// Wallet movements for the native Tickets tab (TH1). Same rule again.
app.use("/v1/me/tickets/history", ticketsHistoryRouter);
// Pause/resume + freeze (native app). Same mount as meRouter, tried first;
// unmatched /v1/me/* paths fall through to the main router below.
app.use("/v1/me", accountStatusRouter);
app.use("/v1/me", meRouter);
app.use("/v1/onboarding", onboardingRouter);
app.use("/v1/assistant", assistantRouter);
app.use("/v1/chat", chatRouter);
app.use("/v1/match-media", matchMediaRouter);
app.use("/v1/matches", matchesRouter);
app.use("/v1/countdown", countdownRouter);
// The Living Canvas. Mounted under its own prefix rather than on /v1/matches
// because it answers for a user with no match at all — IDLE_EXPLORING is the
// state most users are in most of the time.
app.use("/v1/date", dateStateRouter);
// Date Bump. Its own prefix (`/v1/dates/:matchId/bump`) rather than a route on
// the JWT matches router, so the canvas mechanics stay together and the
// existing match surface keeps its shape.
app.use("/v1/dates", dateBumpRouter);
// Same prefix, separate router: the Bump and the Radar share a resource and
// nothing else — one is a two-sided commit, the other a masked read.
app.use("/v1/dates", dateRadarRouter);
// The Scratch Map. Its own prefix and not `/v1/me/*`: it is the only surface a
// client polls while nothing is happening, and it is gated by a consent of its
// own rather than by being logged in.
app.use("/v1/scratch", scratchMapRouter);
// Founder weekly-matches report page + media proxy. Public by design — the
// unguessable token in the path is the authorization (no JWT/initData). Ops-only
// and inert unless FOUNDER_NOTIFY_ENABLED (reports are never created otherwise).
app.use("/v1/founder", founderReportRouter);
// Launch events, attendee side (LAUNCH_EVENTS_PRODUCT_SPEC.md). Dual-rail auth
// like the canvas — one screen, two clients, the same answer.
app.use("/v1/events", eventsPublicRouter);
// The venue door portal. Deliberately OUTSIDE /v1: venue staff are not users,
// they authenticate with a per-event token rather than either client rail, and
// this is not part of the product's client API.
app.use("/gk", gatekeeperRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // body-parser surfaces PayloadTooLargeError (413) and SyntaxError (400)
  // with a proper `.status`. Honor 4xx client errors instead of masking them
  // as 500 — the client needs the right code to distinguish retryable bugs
  // from its own malformed request.
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: err.message });
    return;
  }
  console.error("[public] unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

export function startPublicServer(api?: Api<RawApi>): void {
  // M-11: refuse to start the public API on a weak/empty secret. `jwt.ts`
  // also asserts at call site, but failing here keeps the listener from
  // even binding so a misconfigured deploy is impossible to miss.
  if (!env.JWT_SECRET) {
    console.log("[public] JWT_SECRET not set — public /v1/* API disabled");
    return;
  }
  if (!isStrongJwtSecret(env.JWT_SECRET)) {
    console.error(
      `[public] JWT_SECRET is too short (<${JWT_SECRET_MIN_BYTES} bytes). ` +
        "Refusing to start the public API.",
    );
    return;
  }
  if (api) injectedBotApi = api;
  if (!env.CARTO_API_KEY) {
    console.warn(
      "[public] CARTO_API_KEY not set — map tiles will render with CARTO's " +
        '"API KEY REQUIRED" watermark. Free key: carto.com/basemaps/apikey',
    );
  }
  app.listen(env.PUBLIC_PORT, () => {
    console.log(`[public] /v1/* API listening on :${env.PUBLIC_PORT}`);
  });
}

/** Test-only: inject the bot api without starting the HTTP listener. */
export function __setBotApiForTests(api: Api<RawApi> | null): void {
  injectedBotApi = api;
  calendarRouter = null;
  feedbackRouter = null;
  locationRouter = null;
  telegramOnboardingRouter = null;
  verificationMiniAppRouter = null;
  ticketRouter = null;
}

/**
 * Read the injected bot API so handlers that need to dispatch DMs / fetch
 * Telegram-hosted media (e.g. the verification rerun trigger fired from
 * `/v1/me/photos`) can reach the bot. Returns null when the API hasn't
 * been wired yet — early in startup, in tests that boot the express app
 * without the bot, or if `JWT_SECRET` was empty so `startPublicServer`
 * never ran. Callers MUST handle the null branch (the rerun helper just
 * skips and logs).
 */
export function getBotApi(): Api<RawApi> | null {
  return injectedBotApi;
}
