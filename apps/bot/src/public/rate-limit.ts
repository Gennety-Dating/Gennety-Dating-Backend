import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import type { Request } from "express";

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

/** OTP verify — 10/hour per email. */
export const otpVerifyLimiter = make({
  windowMs: 3_600_000,
  limit: 10,
  keyGenerator: (req): string => `otp-vrf:${(req.body?.email ?? "").toString().toLowerCase()}`,
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

/** Selfie submission — 5/day per user (falls back to IP). */
export const selfieLimiter = make({
  windowMs: 86_400_000,
  limit: 5,
  keyGenerator: (req): string => `selfie:${req.userId ?? ipKey(req)}`,
});
