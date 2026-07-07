/**
 * E.164 phone helpers for the phone-auth (general) registration track.
 *
 * Login/verification is done via the Telegram Mini App one-tap
 * `requestContact`: Telegram returns a real, already-verified number to the
 * bot as a trusted `message.contact`. So this is light normalization plus a
 * structural E.164 check — not full libphonenumber parsing (no new dependency).
 */

/** Structural E.164 check: `+` then 8–15 digits, leading digit non-zero. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/**
 * Normalize a raw phone string to E.164, or return null if it can't be made
 * valid. Strips spaces/dashes/parens/dots, converts a leading `00` to `+`, and
 * ensures a leading `+`. Telegram `Contact.phone_number` often arrives without
 * the `+`, so passing it here (which adds the `+`) is the expected usage.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!s.startsWith("+")) s = `+${s}`;
  return isE164(s) ? s : null;
}
