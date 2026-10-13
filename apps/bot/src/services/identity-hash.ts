import { createHmac } from "node:crypto";
import type { Prisma } from "@gennety/db";
import { env } from "../config.js";

/**
 * Keyed hashes of the identities an account PROVED (decision 2026-09-14,
 * A13-H14). Split out of `safety-tombstone.ts` so a store that only needs to
 * recognise a returning person (`former-account.ts`, the referral program)
 * does not pull in the moderation machinery the tombstone restore depends on.
 *
 * Nothing is stored in the clear: `HMAC-SHA256("<kind>:<value>")` under a key
 * derived from `JWT_SECRET` with a fixed label. Without a `JWT_SECRET` nothing
 * is produced — a weakly keyed hash of a phone number is worse than none.
 */

export type SafetyIdentityKind = "telegram" | "phone" | "email";

/** The identity columns of a user row that a tombstone can be keyed on. */
export interface SafetyIdentitySource {
  telegramId: bigint;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  email: string | null;
  isEmailVerified: boolean;
}

export interface SafetyIdentity {
  kind: SafetyIdentityKind;
  identityHash: string;
}

/** Bumping the label is a deliberate, total reset of every tombstone. */
const TOMBSTONE_KEY_LABEL = "safety-tombstone/v1";

export const IDENTITY_SELECT = {
  telegramId: true,
  phone: true,
  phoneVerifiedAt: true,
  email: true,
  isEmailVerified: true,
} as const satisfies Prisma.UserSelect;

/**
 * Every identity of `user` a tombstone may be keyed on, hashed. Only identities
 * the account PROVED: a positive Telegram id (a negative one is a synthetic
 * placeholder for an app-only account), a phone with `phoneVerifiedAt`, an email
 * with `isEmailVerified`. An unproven value could be someone else's, and keying
 * on it would let a stranger inherit — or erase — another person's history.
 */
export function safetyIdentitiesOf(
  user: SafetyIdentitySource,
  secret: string = env.JWT_SECRET,
): SafetyIdentity[] {
  return keyedIdentitiesOf(user, TOMBSTONE_KEY_LABEL, secret);
}

/**
 * The same proven-identity hashing under a caller-chosen key label, so another
 * store can recognise a returning person without its hashes being joinable to
 * `safety_tombstones` (the referral program keys `referral_identities` with its
 * own label). Same rules as `safetyIdentitiesOf`: proven identities only, and
 * nothing at all without a `JWT_SECRET`.
 */
export function keyedIdentitiesOf(
  user: SafetyIdentitySource,
  label: string,
  secret: string = env.JWT_SECRET,
): SafetyIdentity[] {
  if (!secret) return [];
  const key = createHmac("sha256", secret).update(label).digest();
  const hash = (kind: SafetyIdentityKind, value: string): SafetyIdentity => ({
    kind,
    identityHash: createHmac("sha256", key).update(`${kind}:${value}`).digest("hex"),
  });

  const identities: SafetyIdentity[] = [];
  if (user.telegramId > 0n) identities.push(hash("telegram", user.telegramId.toString()));
  const phone = user.phone?.trim();
  if (phone && user.phoneVerifiedAt) identities.push(hash("phone", phone));
  const email = user.email?.trim().toLowerCase();
  if (email && user.isEmailVerified) identities.push(hash("email", email));
  return identities;
}

