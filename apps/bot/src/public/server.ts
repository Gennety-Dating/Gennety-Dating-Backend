import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import type { Api, RawApi } from "grammy";
import { env } from "../config.js";
import {
  globalLimiter,
  mapTileLimiter,
  personaWebhookLimiter,
} from "./rate-limit.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { assistantRouter } from "./routes/assistant.js";
import { chatRouter } from "./routes/chat.js";
import { matchesRouter } from "./routes/matches.js";
import { countdownRouter } from "./routes/countdown.js";
import { appConfigRouter } from "./routes/app-config.js";
import { phoneAuthRouter } from "./routes/phone-auth.js";
import { liveActivityRouter } from "./routes/live-activity.js";
import { accountStatusRouter } from "./routes/account-status.js";
import { ticketsAppStoreRouter } from "./routes/tickets-appstore.js";
import { premiumAppStoreRouter } from "./routes/premium-appstore.js";
import { appStoreWebhookRouter } from "./routes/appstore-webhook.js";
import { founderReportRouter } from "./routes/founder-report.js";
import { verificationRouter } from "./routes/verification.js";
import { createPersonaWebhookRouter } from "./routes/persona-webhook.js";
import { createCalendarRouter } from "./routes/calendar.js";
import { createFeedbackRouter } from "./routes/feedback.js";
import { createLocationRouter } from "./routes/location.js";
import { createTelegramOnboardingRouter } from "./routes/telegram-onboarding.js";
import { createVerificationMiniAppRouter } from "./routes/verification-mini-app.js";
import { createTicketRouter } from "./routes/ticket.js";
import { createTicketStoreRouter } from "./routes/tickets.js";
import { createVenueChangeRouter } from "./routes/venue-change.js";
import { createPremiumRouter } from "./routes/premium.js";
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
// Persona webhook MUST be mounted before express.json — the signature is HMAC
// of the raw bytes, and JSON re-serialisation would change key order /
// whitespace. The route itself mounts `express.raw` internally.
//
// The bot Api is injected lazily (see `startPublicServer`) because importing
// `./bot.js` here would cycle with `./index.ts`. Until wired, the webhook
// returns 503.
let injectedBotApi: Api<RawApi> | null = null;
let personaRouter: ReturnType<typeof createPersonaWebhookRouter> | null = null;
let calendarRouter: ReturnType<typeof createCalendarRouter> | null = null;
let feedbackRouter: ReturnType<typeof createFeedbackRouter> | null = null;
let locationRouter: ReturnType<typeof createLocationRouter> | null = null;
let telegramOnboardingRouter: ReturnType<typeof createTelegramOnboardingRouter> | null = null;
let verificationMiniAppRouter: ReturnType<typeof createVerificationMiniAppRouter> | null = null;
let ticketRouter: ReturnType<typeof createTicketRouter> | null = null;
let ticketStoreRouter: ReturnType<typeof createTicketStoreRouter> | null = null;
let venueChangeRouter: ReturnType<typeof createVenueChangeRouter> | null = null;
let premiumRouter: ReturnType<typeof createPremiumRouter> | null = null;
app.use("/v1/webhooks/persona", personaWebhookLimiter, (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Persona webhook not ready" });
    return;
  }
  if (!personaRouter) personaRouter = createPersonaWebhookRouter(injectedBotApi);
  personaRouter(req, res, next);
});

// Public map-tile proxy for the location Mini App. Some client networks can't
// reach the tile CDN directly (regional CDN blocks), so the bot fetches tiles
// server-side and streams them — the phone only ever talks to our own origin,
// which it already reaches to load the Mini App. Tiles are public + immutable →
// no auth, aggressive cache. It has a dedicated higher-volume limiter because
// one map view fetches ~15 tiles at once, but it is never an unbounded proxy.
const TILE_SUBDOMAINS = ["a", "b", "c", "d"] as const;
const MAX_TILE_BYTES = 1024 * 1024;
app.get("/v1/maptiles/:z/:x/:y", mapTileLimiter, async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const valid =
    Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) &&
    z >= 0 && z <= 22 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
  if (!valid) {
    res.status(400).end();
    return;
  }
  const sub = TILE_SUBDOMAINS[(x + y) % TILE_SUBDOMAINS.length];
  // `dark_nolabels` = the dark basemap without any place labels. CARTO bakes
  // labels into the raster in the LOCAL language (Ukrainian for Kyiv), and there
  // is no English raster variant, so we drop labels rather than show the wrong
  // language. (English street labels would need a keyed provider / vector tiles.)
  const upstream = `https://${sub}.basemaps.cartocdn.com/dark_nolabels/${z}/${x}/${y}.png`;
  try {
    const upstreamRes = await fetch(upstream, { signal: AbortSignal.timeout(8000) });
    if (!upstreamRes.ok) {
      res.status(502).end();
      return;
    }
    const declaredBytes = Number(upstreamRes.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TILE_BYTES) {
      await upstreamRes.body?.cancel();
      res.status(502).end();
      return;
    }
    if (!upstreamRes.body) {
      res.status(502).end();
      return;
    }
    const reader = upstreamRes.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_TILE_BYTES) {
        await reader.cancel();
        res.status(502).end();
        return;
      }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks, totalBytes);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
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

// Verification Mini App — Persona embedded flow inside the Telegram WebView
// (no redirect to withpersona.com). Same TMA-auth boundary as
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

// StoreKit 2 Premium subscription reporting (native app, JWT auth) — mounted
// BEFORE the generic initData-authed /v1/premium router so this more-specific
// prefix wins. App Store Server Notifications V2 land on /v1/webhooks/appstore.
app.use("/v1/premium/appstore", premiumAppStoreRouter);

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

// Liveness/readiness probe — unauthenticated, intentionally cheap.
app.get("/v1/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// Pre-auth mobile bootstrap: forced-update kill switch + client feature flags.
// Unauthenticated by design (see routes/app-config.ts); globalLimiter applies.
app.use("/v1/app", appConfigRouter);

// Native-app phone rail (Registration v2 general track) — Gateway/Twilio
// fork, 404 while PHONE_AUTH_ENABLED is off. Mounted before the generic
// /v1/auth router so the more-specific prefix wins.
app.use("/v1/auth/phone", phoneAuthRouter);
app.use("/v1/auth", authRouter);
// Mount /v1/me/verification BEFORE /v1/me so Express tries the more-specific
// prefix first — both routers match `/v1/me/verification/*` otherwise.
app.use("/v1/me/verification", verificationRouter);
// Live Activity token registration (same more-specific-prefix rule).
app.use("/v1/me/live-activity-token", liveActivityRouter);
// Pause/resume + freeze (native app). Same mount as meRouter, tried first;
// unmatched /v1/me/* paths fall through to the main router below.
app.use("/v1/me", accountStatusRouter);
app.use("/v1/me", meRouter);
app.use("/v1/onboarding", onboardingRouter);
app.use("/v1/assistant", assistantRouter);
app.use("/v1/chat", chatRouter);
app.use("/v1/matches", matchesRouter);
app.use("/v1/countdown", countdownRouter);
// Founder weekly-matches report page + media proxy. Public by design — the
// unguessable token in the path is the authorization (no JWT/initData). Ops-only
// and inert unless FOUNDER_NOTIFY_ENABLED (reports are never created otherwise).
app.use("/v1/founder", founderReportRouter);

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
  app.listen(env.PUBLIC_PORT, () => {
    console.log(`[public] /v1/* API listening on :${env.PUBLIC_PORT}`);
  });
}

/** Test-only: inject the bot api without starting the HTTP listener. */
export function __setPersonaBotApiForTests(api: Api<RawApi> | null): void {
  injectedBotApi = api;
  personaRouter = null;
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
