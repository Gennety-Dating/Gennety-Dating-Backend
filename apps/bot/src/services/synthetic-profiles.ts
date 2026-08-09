import { prisma, type Gender, type GenderPreference } from "@gennety/db";
import { DEFAULT_MARKET, cityKeyToTimeZone } from "@gennety/shared";
import { refreshUserEmbedding } from "../workers/embedding-refresh.js";

/**
 * Synthetic test profiles (PRODUCT_SPEC §3.1c) — the seeding half.
 *
 * These are the accounts the drop batch's fill pass offers to a real
 * friends-and-family tester when the real pool has nobody left. Everything
 * about them is an ordinary `User` + `Profile`: the pitch generator, the match
 * card, the decision flow and the expiry sweep all read them exactly as they
 * read a person, which is the only way the test tells us anything.
 *
 * Four properties make that safe, and each one is load-bearing:
 *
 *   1. **`syntheticAt`.** The single marker. `buildCandidateSql` excludes it,
 *      so the paid Rematch and the D10 auto-resume probe can never surface
 *      one; `updateEloScores` no-ops on the pair; the admin classifier files
 *      it as `test` so it stays out of every conversion denominator.
 *   2. **`platform: "mobile"` with a negative `telegramId`.** The existing
 *      mechanism for a participant the bot cannot DM (ARCHITECTURE.md →
 *      `users`), so the Profiler, re-engagement, the pinned status banner and
 *      the famine notice all skip them with no new branch anywhere.
 *   3. **No phone, no email.** `registrationTrack: "general"` plus
 *      `phoneVerifiedAt` satisfies the contact-rail gate on its own —
 *      `TRACK_VERIFIED_CONTACT_SQL`'s general branch tests the timestamp, not
 *      the number. Inventing a phone would be actively harmful: `User.phone`
 *      is `@unique`, so a fake number permanently blocks the real person who
 *      one day owns it from registering at all.
 *   4. **They always decline** (`workers/synthetic-partner.ts`), which is what
 *      keeps a real tester from ever being asked to spend real Telegram Stars
 *      on a date that cannot happen.
 *
 * Seeded and removed by `scripts/seed-synthetic-profiles.mjs`, from the
 * operator-owned manifest `scripts/synthetic-profiles.json`. Nothing in the
 * running product creates a row like this.
 */

/**
 * Base for the reserved negative-id band. A slot `n` becomes
 * `-778_000_000 - n`, so ids are fixed rather than random: re-seeding is
 * idempotent, and a row is recognisable at a glance in the database.
 *
 * Deliberately clear of the demo puppets' `-777_...` band. Both sit inside the
 * `[-2^48, -1]` space `public/mobile-user.ts` draws real mobile ids from; a
 * collision would need that RNG to land on one exact value.
 */
export const SYNTHETIC_TELEGRAM_ID_BASE = -778_000_000n;

export function syntheticTelegramId(slot: number): bigint {
  return SYNTHETIC_TELEGRAM_ID_BASE - BigInt(slot);
}

export interface SyntheticProfileDefinition {
  /** Stable 1-based index; decides the fixed `telegramId`. Never reuse one. */
  slot: number;
  firstName: string;
  age: number;
  gender: Gender;
  preference: GenderPreference;
  height: number;
  hobbies: string[];
  partnerPreferences: string;
  /**
   * The dominant matching input (`V_explicit`, weight 0.65) and what the pitch
   * generator actually reads. Written the way a declined-AI-memory user's
   * fallback summary is written: open-ended psychological prose with no
   * demographics, because age/height/city are `V_research`'s job and repeating
   * them here would double-count them.
   */
  psychologicalSummary: string;
  fridayVibeText: string;
  vibeFocusText: string;
  /** −1 internal … +1 external (`V_research` quadrant proximity). */
  energyAxis: number;
  /** −1 experience … +1 connection. */
  orientationAxis: number;
  anchorTags: string[];
  /**
   * Seeded rather than computed — the vision Elo pass runs inside the
   * verification pipeline, which these accounts never go through. Spread
   * around the 500 default on purpose: an identical score across the whole set
   * would make `V_league` a constant and hide exactly the league behaviour a
   * real test is meant to exercise.
   */
  eloScore: number;
}

export interface SyntheticSeedResult {
  userId: string;
  telegramId: bigint;
  created: boolean;
  embeddingOk: boolean;
}

/**
 * Create or update one synthetic profile. Idempotent on `telegramId`, so the
 * manifest can be appended to and re-run without touching earlier rows.
 *
 * Photos are deliberately NOT written here: they are Telegram `file_id`s,
 * which only exist once the bytes have been sent through the production bot,
 * so the upload lives in the script. An existing photo set therefore survives
 * a re-seed — editing a bio must never silently blank someone's pictures.
 */
export async function upsertSyntheticProfile(
  def: SyntheticProfileDefinition,
): Promise<SyntheticSeedResult> {
  const market = DEFAULT_MARKET;
  const now = new Date();
  const telegramId = syntheticTelegramId(def.slot);

  const userFields = {
    firstName: def.firstName,
    age: def.age,
    gender: def.gender,
    preference: def.preference,
    language: "ru" as const,
    platform: "mobile" as const,
    status: "active" as const,
    onboardingStep: "completed" as const,
    // See the header: the general track's gate reads the timestamp, not the
    // number, so `phone` stays NULL and can never squat on a real one.
    registrationTrack: "general",
    phoneVerifiedAt: now,
    verificationStatus: "verified" as const,
    verifiedAt: now,
    hasConsented: true,
    consentedAt: now,
    termsAccepted: true,
    termsAcceptedAt: now,
    // The marker itself, and the reason every guard downstream fires.
    syntheticAt: now,
    // Pre-stamped so the founder ops feed stays silent: `notifyFounderNewUser`
    // updates `where: { founderNotifiedAt: null }`, and a seeded profile card
    // in the real ops DM would be noise indistinguishable from a signup.
    founderNotifiedAt: now,
    referralSource: "synthetic",
  };

  const profileFields = {
    height: def.height,
    hobbies: def.hobbies,
    partnerPreferences: def.partnerPreferences,
    psychologicalSummary: def.psychologicalSummary,
    fridayVibeText: def.fridayVibeText,
    vibeFocusText: def.vibeFocusText,
    energyAxis: def.energyAxis,
    orientationAxis: def.orientationAxis,
    anchorTags: def.anchorTags,
    vibeExtractedAt: now,
    eloScore: def.eloScore,
    eloSeededAt: now,
    homeCity: market.city,
    homeCityKey: market.cityKey,
    homeCountryCode: market.countryCode,
    latitude: market.latitude,
    longitude: market.longitude,
    locationUpdatedAt: now,
    timeZone: cityKeyToTimeZone(market.cityKey),
    // Dirty on purpose, cleared below by a real embedding.
    //
    // `loadEligibleUsersForIds` ends in `.filter((u) => embeddingMap.get(u.id))`,
    // so a vector is REQUIRED even for a pair named explicitly by the fill
    // pass. A profile without one is silently dropped from the snapshot and
    // every pairing attempt is refused with no obvious cause.
    embeddingDirty: true,
  };

  const existing = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });

  const user = await prisma.user.upsert({
    where: { telegramId },
    create: { telegramId, ...userFields },
    update: userFields,
    select: { id: true },
  });

  await prisma.profile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...profileFields },
    update: profileFields,
  });

  // Built through the production refresher rather than written here, so a
  // synthetic vector can never drift from how a real profile's is derived —
  // it reads the same `psychologicalSummary` the pitch generator does.
  const refreshed = await refreshUserEmbedding(user.id);

  return {
    userId: user.id,
    telegramId,
    created: existing === null,
    embeddingOk: refreshed.refreshed > 0 && refreshed.failed === 0,
  };
}

/** Every synthetic account currently in the database, oldest slot first. */
export async function listSyntheticProfiles(): Promise<
  Array<{ id: string; telegramId: bigint; firstName: string | null; gender: string | null }>
> {
  return prisma.user.findMany({
    where: { syntheticAt: { not: null } },
    orderBy: { telegramId: "desc" },
    select: { id: true, telegramId: true, firstName: true, gender: true },
  });
}
