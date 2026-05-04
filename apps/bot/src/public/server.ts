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
import { createPersonaWebhookRouter } from "./routes/persona-webhook.js";
import { createCalendarRouter } from "./routes/calendar.js";

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

// Liveness/readiness probe — unauthenticated, intentionally cheap.
app.get("/v1/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.use("/v1/auth", authRouter);
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
}
