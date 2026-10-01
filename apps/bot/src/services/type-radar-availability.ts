import { ageBandFor, radarBandLive } from "@gennety/shared";

/**
 * Whether a viewer can take Type Radar, and whether they already have — the
 * facts `GET /v1/radar/state` reports, kept in one place so the profile-gaps
 * read (`services/profile-gaps.ts`) cannot drift from the screen it points at.
 */

export type TypeRadarUnavailableReason = "profile-not-ready" | "band-not-live";

/**
 * The two gates the deck applies, in the same order: without an age and a
 * gender preference there is no band and no set to show; a band whose deck is
 * not live yet cannot be served.
 */
export function typeRadarUnavailableReason(user: {
  age: number | null;
  preference: string | null;
}): TypeRadarUnavailableReason | null {
  if (user.age == null || !user.preference) return "profile-not-ready";
  if (!radarBandLive(ageBandFor(user.age))) return "band-not-live";
  return null;
}

/**
 * "We know their type": a compiled preference vector exists. NOT
 * `typeRadarCompletedAt` — that is stamped by a submit AND by the Telegram skip
 * button, so it only says the onboarding step is behind them.
 */
export function typeRadarCalibrated(typePrefTags: unknown): boolean {
  return typePrefTags != null;
}
