import crypto from "node:crypto";

/**
 * Telegram Mini App `initData` validator.
 *
 * Implements the official algorithm
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *
 *   1. Parse initData as URL-encoded key/value pairs.
 *   2. Extract `hash`. Telegram's Bot API 8.0+ `signature` field is accepted
 *      both ways (some clients include it in the HMAC `hash`, some exclude it).
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
  | { valid: false; reason: "missing-hash" | "bad-hash" | "expired" | "future-auth-date" | "missing-user" | "malformed-user" | "missing-auth-date" }
  | { valid: true; user: TelegramInitDataUser; authDate: number };

/**
 * Default freshness window. Telegram doesn't formally publish a TTL; community
 * convention is 1-24 hours. We pick 2 hours: long enough for a user who opened
 * the calendar then briefly switched apps, short enough that a stolen initData
 * can't be reused indefinitely.
 */
export const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 7200;
export const MAX_INIT_DATA_FUTURE_SKEW_SECONDS = 60;

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

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) return { valid: false, reason: "missing-auth-date" };
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate)) return { valid: false, reason: "missing-auth-date" };

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();

  // Build the data-check-string (alphabetically sorted `key=value` pairs) and
  // HMAC it with the bot-token-derived secret key.
  const hashFor = (source: URLSearchParams): string => {
    const keys = [...source.keys()].sort();
    const dataCheckString = keys.map((k) => `${k}=${source.get(k)}`).join("\n");
    return crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  };

  // Telegram clients disagree on whether the Bot API 8.0+ `signature` field
  // participates in the legacy HMAC `hash`. The docs (and most JS validators)
  // exclude it, but real iOS clients — verified on 9.6 against this bot — compute
  // `hash` with `signature` *included* in the data-check-string. Accept either so
  // every client authenticates; both candidates still require the bot token to
  // forge, so this does not weaken the check.
  const candidateHashes = [hashFor(params)];
  if (params.has("signature")) {
    const withoutSignature = new URLSearchParams(params);
    withoutSignature.delete("signature");
    candidateHashes.push(hashFor(withoutSignature));
  }

  // `timingSafeEqual` requires equal-length buffers; the length guard rejects a
  // malformed/truncated hash up front rather than letting Node throw.
  const expected = Buffer.from(hash);
  const matches = candidateHashes.some(
    (candidate) =>
      candidate.length === hash.length &&
      crypto.timingSafeEqual(Buffer.from(candidate), expected),
  );
  if (!matches) return { valid: false, reason: "bad-hash" };

  // Freshness check — guard against initData replay long after the user
  // closed the Mini App.
  const ageSeconds = Math.floor(now.getTime() / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds) return { valid: false, reason: "expired" };
  if (ageSeconds < -MAX_INIT_DATA_FUTURE_SKEW_SECONDS) {
    return { valid: false, reason: "future-auth-date" };
  }

  const userJson = params.get("user");
  if (!userJson) return { valid: false, reason: "missing-user" };

  let user: TelegramInitDataUser;
  try {
    user = JSON.parse(userJson) as TelegramInitDataUser;
  } catch {
    return { valid: false, reason: "malformed-user" };
  }
  if (
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0
  ) {
    return { valid: false, reason: "malformed-user" };
  }

  return { valid: true, user, authDate };
}
