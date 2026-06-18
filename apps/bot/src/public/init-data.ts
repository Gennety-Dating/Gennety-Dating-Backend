import crypto from "node:crypto";

/**
 * Telegram Mini App `initData` validator.
 *
 * Implements the official algorithm
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *
 *   1. Parse initData as URL-encoded key/value pairs.
 *   2. Extract `hash` and remove Telegram's optional Ed25519 `signature`.
 *   3. Build the data-check-string: remaining pairs sorted alphabetically by
 *      key, joined by `\n` as `key=value`.
 *   4. `secret_key = HMAC-SHA256(key="WebAppData", message=BOT_TOKEN)`.
 *   5. `expected_hash = HMAC-SHA256(key=secret_key, message=data_check_string)`
 *      hexadecimal-encoded.
 *   6. Compare in constant time.
 *
 * Also enforces `auth_date` freshness so a leaked initData can't be replayed
 * forever. Telegram itself rotates initData when the user reopens the Mini App.
 */

export interface TelegramInitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_bot?: boolean;
  is_premium?: boolean;
  photo_url?: string;
}

export type InitDataValidation =
  | { valid: false; reason: "missing-hash" | "bad-hash" | "expired" | "missing-user" | "malformed-user" | "missing-auth-date" }
  | { valid: true; user: TelegramInitDataUser; authDate: number };

/**
 * Default freshness window. Telegram doesn't formally publish a TTL; community
 * convention is 1-24 hours. We pick 2 hours: long enough for a user who opened
 * the calendar then briefly switched apps, short enough that a stolen initData
 * can't be reused indefinitely.
 */
export const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 7200;

export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number = DEFAULT_INIT_DATA_MAX_AGE_SECONDS,
  now: Date = new Date(),
): InitDataValidation {
  const params = new URLSearchParams(initData);

  const hash = params.get("hash");
  if (!hash) return { valid: false, reason: "missing-hash" };
  params.delete("hash");
  params.delete("signature");

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) return { valid: false, reason: "missing-auth-date" };
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate)) return { valid: false, reason: "missing-auth-date" };

  // Build the data-check-string: alphabetically sorted `key=value` pairs.
  const keys = [...params.keys()].sort();
  const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  // `timingSafeEqual` requires equal-length buffers; reject mismatched length
  // up front rather than letting Node throw.
  if (expectedHash.length !== hash.length) return { valid: false, reason: "bad-hash" };
  const ok = crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(hash));
  if (!ok) return { valid: false, reason: "bad-hash" };

  // Freshness check — guard against initData replay long after the user
  // closed the Mini App.
  const ageSeconds = Math.floor(now.getTime() / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds) return { valid: false, reason: "expired" };

  const userJson = params.get("user");
  if (!userJson) return { valid: false, reason: "missing-user" };

  let user: TelegramInitDataUser;
  try {
    user = JSON.parse(userJson) as TelegramInitDataUser;
  } catch {
    return { valid: false, reason: "malformed-user" };
  }
  if (typeof user.id !== "number") return { valid: false, reason: "malformed-user" };

  return { valid: true, user, authDate };
}
