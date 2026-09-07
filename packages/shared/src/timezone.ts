/**
 * Best-effort IANA timezone resolution for a user's dating city.
 *
 * Used by the Profiler scheduler (PRODUCT_SPEC §Phase 1b) to anchor the
 * morning/evening batch windows to the user's local wall-clock time. The repo
 * derives all local times via `Intl.DateTimeFormat` (DST-aware, no tz library),
 * so all we need here is an IANA string.
 *
 * v1 scope (per product decision): the student base is Kyiv-centric, so this is
 * a country-code lookup with a few city overrides and a hard `Europe/Kyiv`
 * fallback. Multi-timezone countries (US, RU, …) resolve to a representative
 * zone — good enough for "send the batch in the morning vs evening", and the
 * map can be extended without touching the scheduler.
 */

/**
 * The product's one zone: the fallback for an unresolvable city AND the
 * canonical clock every market-wide decision is made in.
 *
 * It was five separate string literals — the calendar grid
 * (`handlers/matching/scheduler.ts`), the render zone for absolute date/time
 * text (`services/datetime-entity.ts`, and through it the date card), the drop
 * cron (`services/next-batch.ts`), quiet hours (`workers/quiet-hours.ts`) and
 * the re-engagement windows (`workers/re-engagement-schedule.ts`). Identical
 * values, five places to miss. The waitlist already holds fifteen German
 * cities, and on the first non-UA market a half-updated set of literals would
 * split behaviour silently, with every half defensible on its own.
 *
 * Deliberately NOT per-user, even though `Profile.timeZone` is populated: a
 * date belongs to two people, and both sides of a match must read the same
 * wall-clock figures on the same card. That is a product decision (see the
 * scheduling comments in `handlers/matching/venue-negotiation.ts`), not an
 * oversight. What per-user zones do own is what a single person sees about
 * their own day — and that already flows through `cityKeyToTimeZone`.
 */
export const DEFAULT_TIME_ZONE = "Europe/Kyiv";

/** Country code (ISO-3166 alpha-2, upper-case) → representative IANA zone. */
const COUNTRY_TO_TZ: Record<string, string> = {
  UA: "Europe/Kyiv",
  PL: "Europe/Warsaw",
  DE: "Europe/Berlin",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  FR: "Europe/Paris",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  CZ: "Europe/Prague",
  RO: "Europe/Bucharest",
  TR: "Europe/Istanbul",
  US: "America/New_York",
  CA: "America/Toronto",
};

/** City-key overrides for multi-timezone countries (extend as needed). */
const CITY_KEY_TO_TZ: Record<string, string> = {
  "us:los-angeles": "America/Los_Angeles",
  "us:san-francisco": "America/Los_Angeles",
  "us:seattle": "America/Los_Angeles",
  "us:chicago": "America/Chicago",
  "us:austin": "America/Chicago",
  "us:denver": "America/Denver",
};

/**
 * Resolve an IANA timezone from the canonical `homeCityKey` (`<country>:<slug>`)
 * and/or `homeCountryCode`. Returns `Europe/Kyiv` when nothing matches — the
 * scheduler treats a null/unknown zone the same way.
 */
export function cityKeyToTimeZone(
  homeCityKey: string | null | undefined,
  homeCountryCode?: string | null,
): string {
  const key = homeCityKey?.trim().toLowerCase();
  if (key && CITY_KEY_TO_TZ[key]) return CITY_KEY_TO_TZ[key];

  const countryFromKey = key?.includes(":") ? key.split(":")[0] : key;
  const country = (homeCountryCode ?? countryFromKey ?? "").trim().toUpperCase();
  return COUNTRY_TO_TZ[country] ?? DEFAULT_TIME_ZONE;
}

/** True when `tz` is a valid IANA zone the runtime can format with. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
