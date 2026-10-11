import { prisma } from "@gennety/db";
import { cityKeyToTimeZone } from "@gennety/shared";

/**
 * The one clock a match's dates are written and read in: the zone of the
 * DATE CITY (audit C-25).
 *
 * A pair is always in one city — matching joins on an exact
 * `Profile.homeCityKey` — so the city is read from the profiles, A first, the
 * same `userA ?? userB` order the venue pipeline uses for its catalog scope
 * (`venue-intent-v2.ts`, `venue-change.ts`). The zone comes from the CITY
 * (`cityKeyToTimeZone`), never from either side's `Profile.timeZone`: that
 * column is a per-person value, and both sides of one date must read the same
 * wall-clock figures. A pair whose city is unknown resolves to
 * `DEFAULT_TIME_ZONE` — the single-zone behaviour this replaces — so every
 * Kyiv pair (and every legacy row with no city) is unchanged.
 *
 * Read live rather than stored: no column holds it, and the grid itself is a
 * set of instants, so a zone resolved on read only decides how those instants
 * are labelled. A side that switches city mid-negotiation re-labels the grid it
 * already has; the instants and both sides' marks stay exactly as they were.
 */

/**
 * The profile fields the rule reads. Structural so callers select narrowly;
 * optional so a row selected without them reads as "city unknown" (default
 * zone) rather than failing to type-check.
 */
export interface MatchCityProfile {
  homeCityKey?: string | null;
  homeCountryCode?: string | null;
}

export interface MatchCitySides {
  userA: { profile: MatchCityProfile | null } | null;
  userB: { profile: MatchCityProfile | null } | null;
}

/** Drop-in nested select for `userA` / `userB` so callers stay in one query. */
export const MATCH_CITY_PROFILE_SELECT = {
  profile: { select: { homeCityKey: true, homeCountryCode: true } },
} as const;

/** Pure: the zone of the pair's date city. Deterministic for a given row. */
export function matchTimeZone(match: MatchCitySides): string {
  const a = match.userA?.profile ?? null;
  const b = match.userB?.profile ?? null;
  // The side that carries the city key also supplies its country, so a key
  // and a country from two different profiles are never combined.
  const source = a?.homeCityKey ? a : b?.homeCityKey ? b : a?.homeCountryCode ? a : b;
  return cityKeyToTimeZone(source?.homeCityKey ?? null, source?.homeCountryCode ?? null);
}

/** Load-and-resolve for the call sites that do not already hold the profiles. */
export async function loadMatchTimeZone(matchId: string): Promise<string> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userA: { select: MATCH_CITY_PROFILE_SELECT },
      userB: { select: MATCH_CITY_PROFILE_SELECT },
    },
  });
  return matchTimeZone(match ?? { userA: null, userB: null });
}
