import { createPublicKey, type KeyObject } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { env } from "../config.js";

/**
 * "Continue with Telegram" for the native app — verification of the OpenID
 * Connect ID token Telegram's iOS Login SDK hands the client.
 *
 * The trust boundary is this file. The client can send us any string it likes;
 * what makes it an identity is Telegram's RS256 signature over it, checked
 * against Telegram's published public keys, plus the issuer and the audience
 * (our own Client ID — otherwise a token minted for a DIFFERENT bot would log
 * someone into Gennety).
 *
 * There is no client secret anywhere in this flow, and there should not be:
 * we never exchange an authorization code, we only verify an already-issued
 * ID token, and that needs public keys only.
 */

const ISSUER = "https://oauth.telegram.org";
const JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";

/** Signing keys rotate, so the cache is short and a miss is always retried. */
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_TIMEOUT_MS = 5_000;

const LOG_PREFIX = "[telegram-login]";

export interface TelegramLoginIdentity {
  /** Telegram user id — the same value as `User.telegramId`. */
  telegramId: bigint;
  /** E.164, present only with the `phone` scope AND a verified number. */
  phone: string | null;
  firstName: string | null;
  username: string | null;
}

export type TelegramLoginVerifyResult =
  | { ok: true; identity: TelegramLoginIdentity }
  /** 503 — `TELEGRAM_LOGIN_CLIENT_ID` is missing, so no audience to check. */
  | { ok: false; error: "not_configured" }
  /** 502 — we could not reach Telegram's key set. Transient, retryable. */
  | { ok: false; error: "keys_unavailable" }
  /** 401 — signature, issuer, audience, expiry, or subject is not acceptable. */
  | { ok: false; error: "invalid_token" };

interface CachedKeys {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}

let cache: CachedKeys | null = null;
/** Single-flight: a burst of logins must not fan out into N key fetches. */
let inFlight: Promise<CachedKeys | null> | null = null;

/** Test seam — resets the module-level cache between cases. */
export function __resetTelegramLoginKeyCache(): void {
  cache = null;
  inFlight = null;
}

async function fetchKeys(): Promise<CachedKeys | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  try {
    const response = await fetch(JWKS_URL, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`${LOG_PREFIX} JWKS fetch failed`, { status: response.status });
      return null;
    }
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) return null;

    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys) {
      if (typeof jwk !== "object" || jwk === null) continue;
      const { kid, kty } = jwk as { kid?: unknown; kty?: unknown };
      if (typeof kid !== "string" || kty !== "RSA") continue;
      try {
        // Node imports a JWK directly, so this needs no JWKS dependency.
        keys.set(kid, createPublicKey({ key: jwk as never, format: "jwk" }));
      } catch (err) {
        console.warn(`${LOG_PREFIX} unusable JWK`, { kid, err });
      }
    }
    if (keys.size === 0) return null;
    return { keys, fetchedAt: Date.now() };
  } catch (err) {
    console.warn(`${LOG_PREFIX} JWKS fetch threw`, { err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function keysFor(kid: string): Promise<KeyObject | null | "unavailable"> {
  const fresh = cache && Date.now() - cache.fetchedAt < JWKS_TTL_MS;
  if (fresh && cache!.keys.has(kid)) return cache!.keys.get(kid)!;

  // Either the cache is stale, or it is fresh but does not know this `kid` —
  // which is exactly what a key rotation looks like, so re-fetch rather than
  // reject a legitimate token.
  inFlight ??= fetchKeys().finally(() => {
    inFlight = null;
  });
  const loaded = await inFlight;
  if (!loaded) return fresh ? null : "unavailable";
  cache = loaded;
  return loaded.keys.get(kid) ?? null;
}

/**
 * Verify an ID token and extract the identity it asserts.
 *
 * Deliberately strict about the phone: `phone_number` is trusted ONLY when
 * `phone_number_verified` is true. The number becomes `User.phone`, which is
 * unique and doubles as the cross-rail login key — an unverified one would let
 * a caller claim someone else's account.
 */
export async function verifyTelegramIdToken(
  idToken: string,
): Promise<TelegramLoginVerifyResult> {
  if (!env.TELEGRAM_LOGIN_CLIENT_ID) return { ok: false, error: "not_configured" };

  const decoded = jwt.decode(idToken, { complete: true });
  const kid = decoded && typeof decoded === "object" ? decoded.header?.kid : undefined;
  if (typeof kid !== "string") return { ok: false, error: "invalid_token" };

  const key = await keysFor(kid);
  if (key === "unavailable") return { ok: false, error: "keys_unavailable" };
  if (!key) return { ok: false, error: "invalid_token" };

  let payload: JwtPayload;
  try {
    const verified = jwt.verify(idToken, key, {
      // Pinned: without an algorithm allow-list a token could name its own,
      // and `none` would make the signature optional.
      algorithms: ["RS256"],
      issuer: ISSUER,
      audience: env.TELEGRAM_LOGIN_CLIENT_ID,
    });
    if (typeof verified === "string") return { ok: false, error: "invalid_token" };
    payload = verified;
  } catch (err) {
    console.warn(`${LOG_PREFIX} token rejected`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "invalid_token" };
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || !/^\d{1,19}$/.test(sub)) {
    return { ok: false, error: "invalid_token" };
  }
  let telegramId: bigint;
  try {
    telegramId = BigInt(sub);
  } catch {
    return { ok: false, error: "invalid_token" };
  }
  // A non-positive id would collide with the synthetic negative ids we mint for
  // mobile-only users — a space Telegram never issues into.
  if (telegramId <= 0n) return { ok: false, error: "invalid_token" };

  const rawPhone = payload.phone_number;
  const phoneVerified = payload.phone_number_verified === true;
  const phone =
    phoneVerified && typeof rawPhone === "string" && rawPhone.trim()
      ? normalisePhone(rawPhone)
      : null;

  return {
    ok: true,
    identity: {
      telegramId,
      phone,
      firstName: stringClaim(payload.given_name) ?? stringClaim(payload.name),
      username: stringClaim(payload.preferred_username),
    },
  };
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : null;
}

/** Telegram sends E.164; tolerate a missing `+` rather than dropping the number. */
function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}
