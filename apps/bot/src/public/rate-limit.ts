import rateLimit, { ipKeyGenerator, MemoryStore, type Options } from "express-rate-limit";
import type { Request } from "express";
import { createHash } from "node:crypto";

function make(opts: Partial<Options>) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
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
  limit: 100,
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
 * Phone code send — 5/hour per (phone + IP). First anti-SMS-pumping line;
 * the durable backstop (per-phone cooldown + daily cap) lives in
 * `services/phone-verification.ts` because this counter is in-memory.
 */
export const phoneOtpRequestLimiter = make({
  windowMs: 3_600_000,
  limit: 5,
  keyGenerator: (req): string =>
    `phone-otp-req:${(req.body?.phone ?? "").toString()}:${ipKey(req)}`,
  message: { error: "Too many code requests, try again later." },
});

/** Phone code verify — 10/hour per (phone + IP), same rationale as email. */
export const phoneOtpVerifyLimiter = make({
  windowMs: 3_600_000,
  limit: 10,
  keyGenerator: (req): string =>
    `phone-otp-vrf:${(req.body?.phone ?? "").toString()}:${ipKey(req)}`,
  message: { error: "Too many verification attempts." },
});

/** Refresh — 60/hour per IP. */
export const refreshLimiter = make({ windowMs: 3_600_000, limit: 60 });

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

/** Places autocomplete — 60/hour per Telegram Mini App session. */
export const locationSearchLimiter = make({
  windowMs: 3_600_000,
  limit: 60,
  keyGenerator: (req): string => {
    const auth = req.get("authorization") ?? "";
    const sessionKey = auth
      ? createHash("sha256").update(auth).digest("hex").slice(0, 24)
      : ipKey(req);
    return `location-search:${sessionKey}`;
  },
  message: { error: "Too many location searches, try again later." },
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
 * Client analytics batches — 60/hour per install (falls back to IP).
 *
 * Keyed by `installId` from the BODY rather than by user: the funnel starts
 * before an account exists, so `req.userId` is null for exactly the events this
 * endpoint exists to collect. A batch carries up to 200 events, so 60/hour is
 * far above the client's own cadence (one batch per 30s at worst) and still
 * bounds a broken or hostile client.
 */
export const clientEventsLimiter = make({
  windowMs: 3_600_000,
  limit: 60,
  keyGenerator: (req): string => {
    const installId = (req.body as { installId?: unknown } | undefined)?.installId;
    return `client-ev:${typeof installId === "string" && installId ? installId.slice(0, 64) : ipKey(req)}`;
  },
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

/** Mobile chat image upload — 30/hour per user (falls back to IP). */
export const chatUploadLimiter = make({
  windowMs: 3_600_000,
  limit: 30,
  keyGenerator: (req): string => `chat-up:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many image uploads, try again later." },
});
