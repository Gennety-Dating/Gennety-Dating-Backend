import rateLimit, { ipKeyGenerator, MemoryStore, type Options } from "express-rate-limit";
import type { Request } from "express";
import { normalizePhoneE164 } from "@gennety/shared";
import { env } from "../config.js";
import { validateInitData } from "./init-data.js";

/**
 * Общая фабрика всех лимитеров этого файла.
 *
 * Экспортирована ради теста (`rate-limit.test.ts`): инвариант «429 всегда
 * `application/json`» принадлежит именно ей, а не отдельным лимитерам, и
 * проверять его на конкретном лимитере значит не проверять его для того,
 * который напишут завтра. Тот же приём, что и у `resetGlobalRateLimit`
 * ниже. В продакшн-коде вызывать не нужно — все лимитеры уже здесь.
 */
export function make(opts: Partial<Options>) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // JSON по умолчанию, а не строка. Дефолт `express-rate-limit` — обычная
    // строка, и Express 5 отдаёт её как `text/html`. Сгенерированный из
    // OpenAPI клиент iOS требует на 429 строго `application/json` и на
    // несовпадении content-type БРОСАЕТ: ветка `.tooManyRequests`, которая
    // умеет сохранить пару токенов, до вызывающего не доходит, а ошибка
    // чтения ответа неотличима от смерти сессии — человека выкидывает на
    // экран входа без единого его действия. Дефолт здесь закрывает это для
    // всех лимитеров разом, включая те, что напишут потом; частный
    // `message` по-прежнему побеждает через spread ниже.
    message: { error: "Too many requests, try again later." },
    ...opts,
  });
}

/** Normalise the client IP (IPv6-safe via `ipKeyGenerator`). */
function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? "");
}

/**
 * Global floor — 100 req/min per IP.
 *
 * The store is held so tests can clear it between cases. Every request in the
 * public-API suite comes from one loopback address, so the whole file shares a
 * single 100-request budget: adding a handful of cases to one describe block
 * made unrelated tests further down answer 429. That is a property of the test
 * harness, not of the product, and this is the seam that lets the harness say
 * so. Production behaviour is unchanged — an explicit `MemoryStore` is what
 * `express-rate-limit` builds by default anyway.
 */
const globalLimiterStore = new MemoryStore();
export const globalLimiter = make({
  windowMs: 60_000,
  // 600, а не 100. Этот пол стоит ДО аутентификации (`server.ts`), поэтому
  // ключ у него может быть только по IP: ключ по токену подделывается
  // случайной строкой в заголовке и пол перестаёт быть полом. А IP в этом
  // продукте общий — он кампусный, за одним NAT сидят десятки людей. Считаем
  // худший случай одного честного клиента: «Сегодня» — 4 запроса каждые
  // 20 с (12/мин), канва в активном свидании — 3 запроса каждые 5 с
  // (36/мин), прокси-чат — 15/мин. При 100/мин трёх одновременно активных
  // за одним IP хватало, чтобы упереться в потолок, то есть 429 становился
  // штатным ответом живому пользователю. 600/мин = 10 rps с одного адреса:
  // грубый флуд по-прежнему отсекается, а честная толпа за NAT — нет.
  limit: 600,
  store: globalLimiterStore,
});

/** Test-only: forget every counted request against the global floor. */
export function resetGlobalRateLimit(): void {
  globalLimiterStore.resetAll?.();
}

/** OTP send — 5/hour per email + IP. */
export const otpRequestLimiter = make({
  windowMs: 3_600_000,
  limit: 5,
  keyGenerator: (req): string => {
    const email = (req.body?.email ?? "").toString().toLowerCase();
    return `otp-req:${email}:${ipKey(req)}`;
  },
  message: { error: "Too many OTP requests, try again later." },
});

/**
 * OTP verify — 10/hour per (email + IP).
 *
 * Keyed on IP as well as email (audit M1) so a third party who knows a victim's
 * email can't burn the victim's verify budget from an unrelated IP and lock them
 * out of onboarding / login. Guessing the code itself is separately bounded by
 * the per-OTP `attempts` cap (max 5, enforced in `otp.ts`), so adding the IP
 * dimension does not weaken brute-force protection — it only stops the lockout.
 */
export const otpVerifyLimiter = make({
  windowMs: 3_600_000,
  limit: 10,
  keyGenerator: (req): string =>
    `otp-vrf:${(req.body?.email ?? "").toString().toLowerCase()}:${ipKey(req)}`,
  message: { error: "Too many verification attempts." },
});

/**
 * One phone number, one bucket.
 *
 * The durable backstop (per-phone cooldown + daily cap) already works on the
 * normalised number, so this only ever cost extra database and advisory-lock
 * work — but a limiter keyed on formatting is not a limiter on the thing it
 * names. Falls back to the raw string when the number cannot be parsed at all:
 * that request is going to be refused downstream anyway, and it should still
 * count against something.
 */
export function phoneKey(req: Request): string {
  const raw = (req.body?.phone ?? "").toString();
  return normalizePhoneE164(raw) ?? raw.toLowerCase().replace(/\s+/g, "");
}

/**
 * Phone code send — 5/hour per (phone + IP). First anti-SMS-pumping line;
 * the durable backstop (per-phone cooldown + daily cap) lives in
 * `services/phone-verification.ts` because this counter is in-memory.
 */
export const phoneOtpRequestLimiter = make({
  windowMs: 3_600_000,
  limit: 5,
  // Normalised, because the SERVICE normalises: keyed on the raw string,
  // `+15551234567` and `1 555 123 4567` are two buckets for one number.
  keyGenerator: (req): string => `phone-otp-req:${phoneKey(req)}:${ipKey(req)}`,
  message: { error: "Too many code requests, try again later." },
});

/** Phone code verify — 10/hour per (phone + IP), same rationale as email. */
export const phoneOtpVerifyLimiter = make({
  windowMs: 3_600_000,
  limit: 10,
  keyGenerator: (req): string => `phone-otp-vrf:${phoneKey(req)}:${ipKey(req)}`,
  message: { error: "Too many verification attempts." },
});

/**
 * Refresh — 600/hour per IP.
 *
 * `JWT_ACCESS_TTL` = 15 минут, значит каждый активный человек ротирует пару
 * минимум четырежды в час. При 60/час общий NAT упирался в потолок на
 * пятнадцатом активном пользователе, и дальше refresh отвечал 429 — то
 * есть ровно там, где цена ошибки максимальна: неудачный refresh ведёт к
 * экрану входа. Ключ остаётся по IP по той же причине, что и у
 * `globalLimiter` (стоит до аутентификации), поэтому лечим потолком.
 */
export const refreshLimiter = make({ windowMs: 3_600_000, limit: 600 });

/** Whisper / assistant voice — 30/hour per user (falls back to IP). */
export const voiceLimiter = make({
  windowMs: 3_600_000,
  limit: 30,
  keyGenerator: (req): string => `voice:${req.userId ?? ipKey(req)}`,
});

/** Text turns that invoke an LLM — 60/hour per authenticated user. */
export const agentTextLimiter = make({
  windowMs: 3_600_000,
  limit: 60,
  keyGenerator: (req): string => `agent-text:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many assistant requests, slow down for a bit." },
});

/**
 * Who the Mini App request is FROM, for metering purposes.
 *
 * Keying on the raw `initData` string looked right and was not: Telegram issues
 * a fresh `auth_date` and `hash` every time the window opens, so the bucket
 * moved with them. "60 an hour per session" reset by closing and reopening the
 * Mini App — and behind that limiter sits paid Google Places quota.
 *
 * The `user.id` inside is the stable part, and it has to be the VALIDATED one:
 * an id read without checking the signature could simply be edited, which is
 * the same bypass wearing a different hat. Falls back to the IP when the
 * signature does not hold, which is exactly what an unauthenticated caller
 * deserves.
 */
function miniAppKey(req: Request, scope: string, initData?: string): string {
  const header = req.get("authorization") ?? "";
  const raw =
    initData ?? (header.startsWith("tma ") ? header.slice(4).trim() : "");
  if (raw && env.BOT_TOKEN) {
    const parsed = validateInitData(raw, env.BOT_TOKEN);
    if (parsed.valid) return `${scope}:tg:${parsed.user.id}`;
  }
  return `${scope}:${ipKey(req)}`;
}

/** Places autocomplete — 60/hour per Telegram Mini App session. */
export const locationSearchLimiter = make({
  windowMs: 3_600_000,
  limit: 60,
  keyGenerator: (req): string => miniAppKey(req, "location-search"),
  message: { error: "Too many location searches, try again later." },
});

/**
 * Venue photo proxy — 400/hour per Telegram Mini App session.
 *
 * This endpoint spends money on every miss: each request it serves is one
 * Google **Place Photo** call, and it had no limit of its own. The only ceiling
 * was the 100/min-per-IP global floor, which a shared campus NAT already makes
 * generous, and nothing at all bounded an authenticated user over an hour.
 *
 * 400 is well clear of honest use and cheap to reason about: a board is 21 card
 * tiles plus up to 6 gallery shots per venue opened, so an hour of unusually
 * thorough browsing is comfortably inside it, while a script pointed at the
 * proxy stops at a known cost. Keyed on the session (the `tma` initData) rather
 * than the IP, because that is the party actually being metered — and because
 * the whole point is to bound one user, not one campus.
 */
export const photoProxyLimiter = make({
  windowMs: 3_600_000,
  limit: 400,
  // Same rotation problem as the search limiter above, and the same fix: the
  // hash of a string Telegram re-issues on every open is a bucket that resets
  // on every open. Here the initData arrives in the query rather than a header,
  // because this URL goes straight into an `<img src>`.
  keyGenerator: (req): string =>
    miniAppKey(req, "photo-proxy", typeof req.query.tma === "string" ? req.query.tma : ""),
  message: { error: "Too many photo requests, try again later." },
});

/**
 * City lookup for the website's pre-registration form. The visitor has no
 * account yet, so this is keyed by IP alone — the ceiling is higher than the
 * Mini App's because a debounced search-as-you-type burns several calls per
 * city, and a shared campus NAT puts many students behind one address.
 */
export const publicReadLimiter = make({
  windowMs: 3_600_000,
  limit: 240,
  keyGenerator: (req): string => `public-read:${ipKey(req)}`,
  message: { error: "Too many requests, try again later." },
});


/** Public raster-tile proxy — enough for many map pans, bounded against proxy abuse. */
export const mapTileLimiter = make({
  windowMs: 60_000,
  limit: 600,
  keyGenerator: (req): string => `map-tile:${ipKey(req)}`,
  message: { error: "Too many map tile requests, try again later." },
});

/**
 * The Living Canvas — 90/min per authenticated user.
 *
 * This is the only surface in the product designed to be LEFT OPEN and to poll
 * while nothing is happening. In the radar window it costs 24 req/min per user
 * (a state poll and a proximity ping every 5s), which the global floor —
 * keyed by IP at 100/min — does not distinguish from abuse.
 *
 * So the canvas gets a key that identifies the person rather than the address,
 * mounted INSIDE each canvas router so `requireCanvasAuth` has already run and
 * `req.userId` exists. 90 is ~3.75x the designed cadence: no honest client
 * reaches it, and one broken or hostile client can no longer spend an entire
 * shared address's budget.
 *
 * What this does NOT fix, and is worth knowing: the global IP floor still
 * applies on top, so four users behind one carrier-grade NAT with the canvas
 * open in the radar window still contend for 100/min between them —
 * `publicReadLimiter` below already names the same shared-address problem.
 * Solving that properly means not counting authenticated requests against an
 * IP bucket at all, which is a change to every route rather than to this one.
 */
export const canvasLimiter = make({
  windowMs: 60_000,
  limit: 90,
  keyGenerator: (req): string => `canvas:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many requests, slow down for a bit." },
});

/**
 * Curated-venue photos for the iOS standby canvas — 240/min per IP.
 *
 * Keyed by address because this route has no rail to key by: the image loader
 * sends no header, and the signed link is its only credential. That makes the
 * limiter a flood guard and nothing more — the signature already restricts what
 * can be asked for, and the photo cache already makes a repeat free. 240 is ten
 * canvases' worth of pins and cards within one minute behind one address, which
 * a campus NAT can honestly reach.
 */
export const venuePhotoLimiter = make({
  windowMs: 60_000,
  limit: 240,
  keyGenerator: (req): string => `venue-photo:${ipKey(req)}`,
  message: { error: "Too many photo requests, try again later." },
});

/**
 * The venue door portal (`/gk/*`).
 *
 * Keyed by IP, and that is the honest key here rather than a compromise: staff
 * carry no `req.userId`, and one venue's door phones legitimately share one
 * connection. The limit is generous because a queue at a launch party is a
 * burst by nature — someone scanning forty codes in two minutes is the feature
 * working, not an attack — while still bounding a stolen token being used to
 * grind ticket ids. Auth failures are the thing actually worth throttling, and
 * bcrypt does that on its own: each wrong token costs a hash comparison.
 */
export const gatekeeperLimiter = make({
  windowMs: 60_000,
  limit: 240,
  keyGenerator: (req): string => `gk:${ipKey(req)}`,
  message: { error: "Too many scans, slow down for a moment." },
});

/** Selfie submission — 5/day per user (falls back to IP). */
export const selfieLimiter = make({
  windowMs: 86_400_000,
  limit: 5,
  keyGenerator: (req): string => `selfie:${req.userId ?? ipKey(req)}`,
});

/** Account deletion — 5/hour per user (falls back to IP). Irreversible op. */
export const accountDeleteLimiter = make({
  windowMs: 3_600_000,
  limit: 5,
  keyGenerator: (req): string => `acct-del:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many account-deletion attempts, try again later." },
});

/**
 * Client analytics batches — 60/hour per (install + IP).
 *
 * Keyed by `installId` from the BODY rather than by user: the funnel starts
 * before an account exists, so `req.userId` is null for exactly the events this
 * endpoint exists to collect. A batch carries up to 200 events, so 60/hour is
 * far above the client's own cadence (one batch per 30s at worst) and still
 * bounds a broken or hostile client.
 *
 * The IP is part of the key for the reason spelled out on `otpVerifyLimiter`:
 * an identifier a stranger can name must not let them burn somebody else's
 * budget. It does NOT bound rotation — that is what the per-address ceiling
 * below is for.
 */
export const clientEventsLimiter = make({
  windowMs: 3_600_000,
  limit: 60,
  keyGenerator: (req): string => {
    const installId = (req.body as { installId?: unknown } | undefined)?.installId;
    const install =
      typeof installId === "string" && installId ? installId.slice(0, 64) : "anon";
    return `client-ev:${install}:${ipKey(req)}`;
  },
  message: { error: "Too many event batches, try again later." },
});

/**
 * The same endpoint, bounded per ADDRESS — 20/min.
 *
 * `installId` travels in the body, so it is chosen by the caller: while it was
 * the only key, a fresh value on every request meant a fresh budget, and the
 * per-install limit above could not be reached by anyone who did not want to
 * reach it. Unauthenticated rows in the events table were bounded only by the
 * global floor.
 *
 * 20/min is derived from the client rather than picked: `AnalyticsCore` flushes
 * at most once per 30s (`flushDelay`), so one device cannot exceed 2/min, and a
 * shared address would need ten devices flushing flat out — well above a
 * short-session product's real traffic, and still three times stricter than the
 * global floor. Rotation now costs an attacker addresses instead of nothing.
 */
export const clientEventsIpLimiter = make({
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req): string => `client-ev-ip:${ipKey(req)}`,
  message: { error: "Too many event batches, try again later." },
});

/** Profile photo upload — 10/hour per user (falls back to IP). */
export const photoUploadLimiter = make({
  windowMs: 3_600_000,
  limit: 10,
  keyGenerator: (req): string => `photo-up:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many photo uploads, try again later." },
});

/** Mobile chat turn — 60/hour per user (falls back to IP). */
export const chatMessageLimiter = make({
  windowMs: 3_600_000,
  limit: 60,
  keyGenerator: (req): string => `chat-msg:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many chat messages, slow down for a bit." },
});

/**
 * Music search — 60/min per user.
 *
 * Search-as-you-type behind the client's debounce is a handful of calls per
 * query, so 60/min is far above honest use and still bounds a client stuck in
 * a loop. The ceiling that actually matters is Spotify's, and it is app-wide:
 * every Gennety user shares one Client Credentials quota — which is why the
 * service also caches answers (`services/music/spotify.ts`).
 */
export const musicSearchLimiter = make({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req): string => `music-search:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many searches, slow down for a bit." },
});

/** Spotify top-tracks import start — 10/hour per user; each is a trip to Spotify. */
export const spotifyImportLimiter = make({
  windowMs: 3_600_000,
  limit: 10,
  keyGenerator: (req): string => `spotify-import:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many import attempts, try again later." },
});

/** Mobile chat image upload — 30/hour per user (falls back to IP). */
export const chatUploadLimiter = make({
  windowMs: 3_600_000,
  limit: 30,
  keyGenerator: (req): string => `chat-up:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many image uploads, try again later." },
});
