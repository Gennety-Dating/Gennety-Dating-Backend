import type { Profile, User } from "@gennety/db";

/**
 * Shape returned by `/v1/me` and `/v1/auth/otp/verify`. Mirrors
 * `gennety-mobile/src/api/types.ts` — keep both sides in sync.
 *
 * We intentionally drop Telegram-only fields (`telegramId`, session state,
 * status banner ids) and anything vector-y (`embedding`, `visualVector`).
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
  status: User["status"];
  onboardingStep: User["onboardingStep"];
}

export interface SerializedProfile {
  hobbies: string[];
  partnerPreferences: string | null;
  psychologicalSummary: string | null;
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  photos: string[];
  matchRadius: Profile["matchRadius"];
}

export function serializeUser(user: User): SerializedUser {
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
    status: user.status,
    onboardingStep: user.onboardingStep,
  };
}

export function serializeProfile(profile: Profile): SerializedProfile {
  return {
    hobbies: profile.hobbies,
    partnerPreferences: profile.partnerPreferences,
    psychologicalSummary: profile.psychologicalSummary,
    ageRangeMin: profile.ageRangeMin,
    ageRangeMax: profile.ageRangeMax,
    photos: profile.photos,
    matchRadius: profile.matchRadius,
  };
}
