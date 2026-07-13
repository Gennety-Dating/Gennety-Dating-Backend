import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
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

/** Global floor — 100 req/min per IP. */
export const globalLimiter = make({ windowMs: 60_000, limit: 100 });

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

/** Persona webhook ingress — protects raw-body parsing before global limits. */
export const personaWebhookLimiter = make({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req): string => `persona-webhook:${ipKey(req)}`,
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

/** Profile photo upload — 10/hour per user (falls back to IP). */
export const photoUploadLimiter = make({
  windowMs: 3_600_000,
  limit: 10,
  keyGenerator: (req): string => `photo-up:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many photo uploads, try again later." },
});

/** Aether Concierge chat turn — 60/hour per user (falls back to IP). */
export const chatMessageLimiter = make({
  windowMs: 3_600_000,
  limit: 60,
  keyGenerator: (req): string => `chat-msg:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many chat messages, slow down for a bit." },
});

/** Aether Concierge image upload — 30/hour per user (falls back to IP). */
export const chatUploadLimiter = make({
  windowMs: 3_600_000,
  limit: 30,
  keyGenerator: (req): string => `chat-up:${req.userId ?? ipKey(req)}`,
  message: { error: "Too many image uploads, try again later." },
});
