import type { Prisma } from "@gennety/db";

export interface ContactVerificationState {
  registrationTrack?: string | null;
  email?: string | null;
  isEmailVerified?: boolean | null;
  phoneVerifiedAt?: Date | null;
}

/**
 * Registration v2 contact verification is track-aware:
 * - general users must prove control of a Telegram-vouched phone number;
 * - student and pre-fork legacy users must prove a university email.
 *
 * The product admits the union of these two cohorts, not either credential for
 * every individual user. Keep all activation and matchmaking gates on this
 * predicate so switching tracks cannot turn an unrelated credential into a
 * bypass.
 */
export function hasTrackVerifiedContact(user: ContactVerificationState): boolean {
  if (user.registrationTrack === "general") {
    return user.phoneVerifiedAt != null;
  }
  return Boolean(user.isEmailVerified && user.email);
}

export function unresolvedTrackContactGate(
  user: ContactVerificationState,
): "email-required" | "phone-required" | null {
  if (hasTrackVerifiedContact(user)) return null;
  return user.registrationTrack === "general" ? "phone-required" : "email-required";
}

/** Prisma equivalent of {@link hasTrackVerifiedContact}. */
export const TRACK_VERIFIED_CONTACT_WHERE: Prisma.UserWhereInput = {
  OR: [
    {
      registrationTrack: "general",
      phoneVerifiedAt: { not: null },
    },
    {
      registrationTrack: { not: "general" },
      isEmailVerified: true,
      email: { not: null },
    },
    {
      registrationTrack: null,
      isEmailVerified: true,
      email: { not: null },
    },
  ],
};

/** SQL equivalent used by the pgvector candidate query (`u` = users alias). */
export const TRACK_VERIFIED_CONTACT_SQL = `(
  (u.registration_track = 'general' AND u.phone_verified_at IS NOT NULL)
  OR
  (u.registration_track IS DISTINCT FROM 'general' AND u.is_email_verified AND u.email IS NOT NULL)
)`;
