import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import type { Api, RawApi } from "grammy";
import { env } from "../config.js";
import { globalLimiter } from "./rate-limit.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { assistantRouter } from "./routes/assistant.js";
import { chatRouter } from "./routes/chat.js";
import { matchesRouter } from "./routes/matches.js";
import { countdownRouter } from "./routes/countdown.js";
import { verificationRouter } from "./routes/verification.js";
import { webRegistrationRouter } from "./routes/web-registration.js";
import { createPersonaWebhookRouter } from "./routes/persona-webhook.js";
import { createCalendarRouter } from "./routes/calendar.js";
import { createFeedbackRouter } from "./routes/feedback.js";
import { createLocationRouter } from "./routes/location.js";
import { createTelegramOnboardingRouter } from "./routes/telegram-onboarding.js";
import { createVerificationMiniAppRouter } from "./routes/verification-mini-app.js";
import { createTicketRouter } from "./routes/ticket.js";
import { createVenueChangeRouter } from "./routes/venue-change.js";

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
app.use(
  cors({
    origin: env.PUBLIC_CORS_ORIGIN === "*" ? "*" : env.PUBLIC_CORS_ORIGIN.split(","),
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
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
let venueChangeRouter: ReturnType<typeof createVenueChangeRouter> | null = null;
app.use("/v1/webhooks/persona", (req, res, next) => {
  if (!injectedBotApi) {
    res.status(503).json({ error: "Persona webhook not ready" });
    return;
  }
  if (!personaRouter) personaRouter = createPersonaWebhookRouter(injectedBotApi);
  personaRouter(req, res, next);
});

app.use(express.json({ limit: "512kb" }));
app.use(globalLimiter);

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

// Liveness/readiness probe — unauthenticated, intentionally cheap.
app.get("/v1/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.use("/v1/auth", authRouter);
app.use("/v1/web-registration", webRegistrationRouter);
// Mount /v1/me/verification BEFORE /v1/me so Express tries the more-specific
// prefix first — both routers match `/v1/me/verification/*` otherwise.
app.use("/v1/me/verification", verificationRouter);
app.use("/v1/me", meRouter);
app.use("/v1/onboarding", onboardingRouter);
app.use("/v1/assistant", assistantRouter);
app.use("/v1/chat", chatRouter);
app.use("/v1/matches", matchesRouter);
app.use("/v1/countdown", countdownRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  if (env.JWT_SECRET.length < 16) {
    console.error(
      "[public] JWT_SECRET is too short (<16 chars). Refusing to start the public API.",
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
