import type { Prisma, Profile, User } from "@gennety/db";

/**
 * Exactly the user columns `serializeUser` reads. Routes that only answer with
 * the serialized user select this instead of the whole row — which carries the
 * agent's `message_history` (up to 200 replies) and a dozen JSON blobs no
 * response ever shows. `serializeUser` is typed by it, so a field added there
 * without being added here does not compile.
 */
export const SERIALIZED_USER_SELECT = {
  id: true,
  email: true,
  universityDomain: true,
  firstName: true,
  surname: true,
  age: true,
  gender: true,
  preference: true,
  major: true,
  language: true,
  theme: true,
  themeMode: true,
  status: true,
  onboardingStep: true,
  termsAccepted: true,
  researchOptIn: true,
  analyticsOptIn: true,
  ticketBalance: true,
} as const satisfies Prisma.UserSelect;

export type SerializableUser = Prisma.UserGetPayload<{ select: typeof SERIALIZED_USER_SELECT }>;

/** Exactly the profile columns `serializeProfile` reads — same reasoning as the user's. */
export const SERIALIZED_PROFILE_SELECT = {
  hobbies: true,
  partnerPreferences: true,
  psychologicalSummary: true,
  ageRangeMin: true,
  ageRangeMax: true,
  photos: true,
  matchRadius: true,
  standbyCount: true,
  latitude: true,
  longitude: true,
  locationUpdatedAt: true,
  homeCity: true,
  homeCountryCode: true,
  homeCityKey: true,
  homePlaceId: true,
} as const satisfies Prisma.ProfileSelect;

export type SerializableProfile = Prisma.ProfileGetPayload<{
  select: typeof SERIALIZED_PROFILE_SELECT;
}>;

/** The `{ user, profile }` answer of the `/v1/me` family, read in one call. */
export const SERIALIZED_ME_SELECT = {
  ...SERIALIZED_USER_SELECT,
  profile: { select: SERIALIZED_PROFILE_SELECT },
} as const satisfies Prisma.UserSelect;

/**
 * Shape returned by `/v1/me` and `/v1/auth/otp/verify`. Mirrors
 * `gennety-mobile/src/api/types.ts` — keep both sides in sync.
 *
 * We intentionally drop Telegram-only fields (`telegramId`, session state,
 * status banner ids) and the `embedding` vector.
 */
export interface SerializedUser {
  id: string;
  email: string | null;
  universityDomain: string | null;
  firstName: string | null;
  surname: string | null;
  age: number | null;
  gender: User["gender"];
  preference: User["preference"];
  major: string | null;
  language: User["language"];
  /**
   * Effective colour theme — what the app paints and what the server bakes
   * into the Telegram PNG cards. Two-valued on purpose (§ `Theme`).
   */
  theme: User["theme"];
  /**
   * How that theme was chosen: `system` (the iPhone decides), `light`, `dark`.
   * The client needs it to show the right radio back; `theme` alone could not
   * tell "follow the phone, which is dark now" from "dark".
   */
  themeMode: User["themeMode"];
  status: User["status"];
  onboardingStep: User["onboardingStep"];
  termsAccepted: boolean;
  researchOptIn: boolean;
  /** Pulse: consent to product analytics (pulse-analytics.md §2). */
  analyticsOptIn: boolean;
  /**
   * Date Ticket wallet balance (§3.5b). Lives on the user rather than behind a
   * wallet route because the native store and the gate both need it and the
   * app already refetches `/v1/me`; a separate endpoint would be a third call
   * for one integer. Always present — it is simply 0 while tickets are off.
   */
  ticketBalance: number;
}

export interface SerializedProfile {
  hobbies: string[];
  partnerPreferences: string | null;
  psychologicalSummary: string | null;
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  photos: string[];
  matchRadius: Profile["matchRadius"];
  standbyCount: number;
  latitude: number | null;
  longitude: number | null;
  locationUpdatedAt: string | null;
  homeCity: string | null;
  homeCountryCode: string | null;
  homeCityKey: string | null;
  homePlaceId: string | null;
}

export function serializeUser(user: SerializableUser): SerializedUser {
  return {
    id: user.id,
    email: user.email,
    universityDomain: user.universityDomain,
    firstName: user.firstName,
    surname: user.surname,
    age: user.age,
    gender: user.gender,
    preference: user.preference,
    major: user.major,
    language: user.language,
    theme: user.theme,
    themeMode: user.themeMode,
    status: user.status,
    onboardingStep: user.onboardingStep,
    termsAccepted: user.termsAccepted,
    researchOptIn: user.researchOptIn,
    // Older deployed Prisma clients do not expose the Pulse column yet.
    // Keep the native auth contract complete without inventing consent.
    analyticsOptIn: user.analyticsOptIn ?? false,
    ticketBalance: user.ticketBalance,
  };
}

export function serializeProfile(profile: SerializableProfile): SerializedProfile {
  return {
    hobbies: profile.hobbies,
    partnerPreferences: profile.partnerPreferences,
    psychologicalSummary: profile.psychologicalSummary,
    ageRangeMin: profile.ageRangeMin,
    ageRangeMax: profile.ageRangeMax,
    photos: profile.photos,
    matchRadius: profile.matchRadius,
    standbyCount: profile.standbyCount,
    latitude: profile.latitude,
    longitude: profile.longitude,
    locationUpdatedAt: profile.locationUpdatedAt
      ? profile.locationUpdatedAt.toISOString()
      : null,
    homeCity: profile.homeCity ?? null,
    homeCountryCode: profile.homeCountryCode ?? null,
    homeCityKey: profile.homeCityKey ?? null,
    homePlaceId: profile.homePlaceId ?? null,
  };
}
