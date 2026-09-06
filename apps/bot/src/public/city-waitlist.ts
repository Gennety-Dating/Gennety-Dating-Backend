import { prisma, type CityWaitlistEntry } from "@gennety/db";
import { findCityByKey } from "@gennety/shared";

/**
 * The city waitlist — the half of the dating-city step that does NOT continue
 * registration.
 *
 * Picking a launched market writes `Profile.homeCityKey` and onboarding walks
 * on. Picking a city from the expansion list writes a row here and onboarding
 * stops: the person is told we are not open there yet, and the row is the
 * demand signal the founder reads before choosing the next market.
 *
 * Deliberately separate from `Profile.home*` (see `CityWaitlistEntry` in the
 * schema): `homeCityKey` is the matching boundary, and a waitlist key sitting
 * in it would eventually pair two people for a date in a city with no venues.
 * Nothing in this module ever touches `Profile`.
 */

export interface CityWaitlistState {
  cityKey: string;
  city: string;
  countryCode: string;
  joinedAt: string;
}

export type CityWaitlistJoin =
  | { ok: true; entry: CityWaitlistEntry }
  | { ok: false; error: "city-not-waitlisted" };

/**
 * Record (or move) this user's waitlist city.
 *
 * The key is re-resolved against the catalog rather than trusted from the
 * request, so the stored display name and country are ours, not the client's —
 * the same rule `homeLocationForMarket` applies to a launched market. A key
 * that names a launched market or no city at all is refused: the first belongs
 * on `Profile`, the second is not demand for anything.
 */
export async function joinCityWaitlist(
  userId: string,
  cityKey: string,
): Promise<CityWaitlistJoin> {
  const city = findCityByKey(cityKey);
  if (!city || city.status !== "waitlist") {
    return { ok: false, error: "city-not-waitlisted" };
  }

  const data = {
    cityKey: city.cityKey,
    city: city.city,
    countryCode: city.countryCode,
  };
  const entry = await prisma.cityWaitlistEntry.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
  return { ok: true, entry };
}

/**
 * Drop this user off the waitlist. Called both by the "choose another city"
 * button and — unconditionally — by the launched-market branch of
 * `/city/select`, so a user can never hold a home location and a waitlist row
 * at the same time. Idempotent: leaving a waitlist you are not on is not an
 * error, it is the state the caller wanted.
 */
export async function leaveCityWaitlist(userId: string): Promise<void> {
  await prisma.cityWaitlistEntry.deleteMany({ where: { userId } });
}

export async function findCityWaitlistEntry(
  userId: string,
): Promise<CityWaitlistEntry | null> {
  return prisma.cityWaitlistEntry.findUnique({ where: { userId } });
}

/** Client-facing shape for `/state` and the iOS rail. */
export function serializeCityWaitlist(
  entry: Pick<CityWaitlistEntry, "cityKey" | "city" | "countryCode" | "createdAt"> | null,
): CityWaitlistState | null {
  if (!entry) return null;
  return {
    cityKey: entry.cityKey,
    city: entry.city,
    countryCode: entry.countryCode,
    joinedAt: entry.createdAt.toISOString(),
  };
}
