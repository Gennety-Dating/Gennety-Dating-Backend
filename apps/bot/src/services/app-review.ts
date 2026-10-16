import { timingSafeEqual } from "node:crypto";
import { prisma, type Prisma } from "@gennety/db";
import { DEFAULT_MARKET, cityKeyToTimeZone } from "@gennety/shared";
import { env } from "../config.js";
import { getBalance, grantTickets } from "./ticket-wallet.js";

/**
 * The App Store review account (founder decision 2026-10-15,
 * `docs/operations/app-review-account.md`).
 *
 * Apple's reviewer cannot receive a university email, pass a selfie liveness
 * check as a real student, or wait for an 18:00 drop that pairs them with a
 * real person. So production carries ONE narrow exception, off unless both
 * `APP_REVIEW_EMAIL` and `APP_REVIEW_CODE` are set:
 *
 *   1. That one address signs in with that one 6-digit code — no mail is sent,
 *      and every other address goes through the ordinary OTP rail untouched.
 *   2. It lands on a finished, verified profile ("Alex").
 *   3. It is paired with a stand-in partner ("Gleb") whom
 *      `workers/app-review-partner.ts` walks through every step a real partner
 *      would take, so the reviewer sees the whole flow in minutes.
 *
 * What keeps it from touching anyone real: both accounts live in a reserved
 * negative `telegramId` band (`APP_REVIEW_TELEGRAM_ID_*`), and the matching
 * engine excludes that band from the pool on both the Prisma scans and the
 * pgvector SQL. A review account can only ever be paired with the other one.
 *
 * Deliberately NOT `syntheticAt`: the synthetic-partner worker auto-declines
 * every match with a synthetic side, which is the opposite of what the stand-in
 * is for.
 */

/** Reserved band. Mobile users get random ids far below it (`mobile-user.ts`). */
export const APP_REVIEW_TELEGRAM_ID_MAX = -779_000_001n;
export const APP_REVIEW_TELEGRAM_ID_MIN = -779_000_099n;
export const APP_REVIEW_REVIEWER_TELEGRAM_ID = -779_000_001n;
export const APP_REVIEW_PARTNER_TELEGRAM_ID = -779_000_002n;

/** Prisma filter that drops both review accounts from a user scan. */
export const NOT_APP_REVIEW_ACCOUNT_WHERE: Prisma.UserWhereInput = {
  NOT: {
    telegramId: { gte: APP_REVIEW_TELEGRAM_ID_MIN, lte: APP_REVIEW_TELEGRAM_ID_MAX },
  },
};

/** SQL twin for the candidate query (`u` = users alias). Literal, no input. */
export const NOT_APP_REVIEW_ACCOUNT_SQL =
  `u.telegram_id NOT BETWEEN ${APP_REVIEW_TELEGRAM_ID_MIN} AND ${APP_REVIEW_TELEGRAM_ID_MAX}`;

export function isAppReviewTelegramId(telegramId: bigint): boolean {
  return telegramId >= APP_REVIEW_TELEGRAM_ID_MIN && telegramId <= APP_REVIEW_TELEGRAM_ID_MAX;
}

export function isAppReviewEnabled(config: AppReviewConfig = env): boolean {
  return config.APP_REVIEW_EMAIL !== "" && config.APP_REVIEW_CODE !== "";
}

export interface AppReviewConfig {
  APP_REVIEW_EMAIL: string;
  APP_REVIEW_CODE: string;
}

/**
 * Why this configuration must not boot. A half-set pair is a typo waiting to
 * look like "the review account is broken" mid-review; a guessable code turns
 * a one-account exception into an open door.
 */
export function appReviewConfigurationErrors(config: AppReviewConfig): string[] {
  const email = config.APP_REVIEW_EMAIL;
  const code = config.APP_REVIEW_CODE;
  if (email === "" && code === "") return [];
  const errors: string[] = [];
  if (email === "" || code === "") {
    errors.push("APP_REVIEW_EMAIL and APP_REVIEW_CODE must be set together (or both left empty)");
    return errors;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("APP_REVIEW_EMAIL is not an email address");
  }
  if (!/^\d{6}$/.test(code)) {
    // The iOS code field is exactly six digits and auto-submits.
    errors.push("APP_REVIEW_CODE must be exactly 6 digits");
  } else if (isGuessableCode(code)) {
    errors.push("APP_REVIEW_CODE is guessable (repeated or sequential digits) — pick a random one");
  }
  return errors;
}

function isGuessableCode(code: string): boolean {
  if (/^(\d)\1+$/.test(code)) return true;
  const digits = [...code].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]!));
  if (steps.size === 1 && (steps.has(1) || steps.has(-1))) return true;
  return ["123123", "121212", "112233", "654321", "000001", "100000"].includes(code);
}

export function isAppReviewEmail(email: string, config: AppReviewConfig = env): boolean {
  return isAppReviewEnabled(config) && email.trim().toLowerCase() === config.APP_REVIEW_EMAIL;
}

// ── Code check with a global lockout ──────────────────────────────────────────

/**
 * Wrong codes across ALL callers before the address locks for the window. The
 * per-email+IP limiter (10/h) still applies on top; this one is global because
 * the address is public knowledge once it sits in App Store Connect notes, and
 * an attacker rotating IPs must not get unlimited guesses at six digits.
 */
export const APP_REVIEW_MAX_FAILURES = 20;
export const APP_REVIEW_LOCKOUT_WINDOW_MS = 60 * 60 * 1000;

let failureTimes: number[] = [];

export type AppReviewCodeResult = "ok" | "mismatch" | "locked";

export function checkAppReviewCode(
  code: string,
  now: number = Date.now(),
  config: AppReviewConfig = env,
): AppReviewCodeResult {
  failureTimes = failureTimes.filter((t) => now - t < APP_REVIEW_LOCKOUT_WINDOW_MS);
  if (failureTimes.length >= APP_REVIEW_MAX_FAILURES) return "locked";
  const given = Buffer.from(code);
  const expected = Buffer.from(config.APP_REVIEW_CODE);
  const ok =
    expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
  if (ok) return "ok";
  failureTimes.push(now);
  return "mismatch";
}

/** Tests only. */
export function resetAppReviewFailures(): void {
  failureTimes = [];
}

// ── The two accounts ─────────────────────────────────────────────────────────

interface Persona {
  telegramId: bigint;
  firstName: string;
  age: number;
  gender: "male" | "female";
  preference: "men" | "women";
  height: number;
  hobbies: string[];
  partnerPreferences: string;
  psychologicalSummary: string;
  fridayVibeText: string;
  vibeFocusText: string;
  energyAxis: number;
  orientationAxis: number;
  anchorTags: string[];
  /** Storage paths in the profile-photo bucket; empty = leave photos alone. */
  photos: string[];
}

/**
 * The stand-in partner's pictures: the founder's own photos (his consent,
 * 2026-10-16), uploaded once by hand to these fixed paths in the profile-photo
 * bucket — see `docs/operations/app-review-account.md`. Fixed paths, not
 * `<userId>/…`, so the row can be recreated without re-uploading.
 */
export const APP_REVIEW_PARTNER_PHOTOS = [
  "app-review/partner-1.jpg",
  "app-review/partner-2.jpg",
  "app-review/partner-3.jpg",
  "app-review/partner-4.jpg",
];

const REVIEWER: Persona = {
  telegramId: APP_REVIEW_REVIEWER_TELEGRAM_ID,
  firstName: "Alex",
  age: 21,
  gender: "female",
  preference: "men",
  height: 168,
  hobbies: ["coffee", "running", "photography", "board games"],
  partnerPreferences: "Someone curious and easy to talk to, who likes a slow evening out.",
  psychologicalSummary:
    "Calm and curious, a good listener with a dry sense of humour. Studies " +
    "architecture and spends weekends running along the river or taking " +
    "film photos around the old town. Prefers small quiet places to loud ones " +
    "and long conversations to small talk.",
  fridayVibeText: "A quiet café, good coffee and a conversation that runs late.",
  vibeFocusText: "The person matters more than the place.",
  energyAxis: -0.2,
  orientationAxis: 0.5,
  anchorTags: ["coffee", "photography", "city walks"],
  photos: [],
};

const PARTNER: Persona = {
  telegramId: APP_REVIEW_PARTNER_TELEGRAM_ID,
  firstName: "Gleb",
  age: 18,
  gender: "male",
  preference: "women",
  height: 181,
  hobbies: ["building apps", "design", "city walks", "documentaries"],
  partnerPreferences:
    "Someone with their own passion and opinions — interesting to listen to, " +
    "and fine to disagree with.",
  psychologicalSummary:
    "Energetic and curious with a clear inner compass. Builds apps and cares " +
    "about small details others skip, on screens and in people. Quick to " +
    "laugh, values honesty over small talk, and recharges with long walks " +
    "through the city.",
  fridayVibeText: "A small place where nobody rushes us, and a conversation that wanders.",
  vibeFocusText: "Mostly the person, but the atmosphere should not get in the way.",
  energyAxis: 0.2,
  orientationAxis: 0.7,
  anchorTags: ["tech", "design", "films", "slow evenings"],
  photos: APP_REVIEW_PARTNER_PHOTOS,
};

/**
 * Create the reviewer, or put it back into a usable state. Called on every
 * successful review sign-in, so an account the reviewer deleted (the row is
 * gone) or left half-way comes back whole. Only the gates are reset; whatever
 * the reviewer edited in the profile is left alone.
 */
export async function ensureAppReviewReviewer(
  config: AppReviewConfig = env,
): Promise<Prisma.UserGetPayload<object>> {
  const email = config.APP_REVIEW_EMAIL;
  // A stray non-review row holding the address (e.g. someone registered it
  // through the ordinary rail before the env was set) must not be adopted.
  const holder = await prisma.user.findUnique({ where: { email }, select: { telegramId: true } });
  if (holder && holder.telegramId !== REVIEWER.telegramId) {
    throw new Error("APP_REVIEW_EMAIL already belongs to a non-review account");
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const user = await upsertPersona(REVIEWER, {
    email,
    isEmailVerified: true,
    universityDomain: domain,
    registrationTrack: "student",
  });
  return user;
}

/** Create or refresh the stand-in partner. Idempotent; called every tick. */
export async function ensureAppReviewPartner(): Promise<Prisma.UserGetPayload<object>> {
  return upsertPersona(PARTNER, {
    // General track + a verified-phone timestamp satisfies the contact gate
    // without inventing a phone number (same as the demo puppets).
    registrationTrack: "general",
    phoneVerifiedAt: new Date(),
  });
}

async function upsertPersona(
  persona: Persona,
  contact: Prisma.UserUncheckedUpdateInput,
): Promise<Prisma.UserGetPayload<object>> {
  const market = DEFAULT_MARKET;
  const now = new Date();
  const gateFields = {
    platform: "mobile" as const,
    status: "active" as const,
    onboardingStep: "completed" as const,
    verificationStatus: "verified" as const,
    hasConsented: true,
    termsAccepted: true,
    ...contact,
  };

  const existing = await prisma.user.findUnique({
    where: { telegramId: persona.telegramId },
    select: { id: true, verifiedAt: true, consentedAt: true, termsAcceptedAt: true },
  });

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          ...gateFields,
          verifiedAt: existing.verifiedAt ?? now,
          consentedAt: existing.consentedAt ?? now,
          termsAcceptedAt: existing.termsAcceptedAt ?? now,
        },
      })
    : await prisma.user.create({
        data: {
          telegramId: persona.telegramId,
          firstName: persona.firstName,
          age: persona.age,
          gender: persona.gender,
          preference: persona.preference,
          language: "en",
          verifiedAt: now,
          consentedAt: now,
          termsAcceptedAt: now,
          ...gateFields,
        } as Prisma.UserUncheckedCreateInput,
      });

  // A new profile starts `embeddingDirty`; the partner worker builds the vector
  // before it pitches (matching requires one even for a named pair).
  const profile = await prisma.profile.findUnique({
    where: { userId: user.id },
    select: { userId: true, photos: true },
  });
  if (profile && persona.photos.length > 0 && !samePaths(profile.photos, persona.photos)) {
    // Only the partner carries photos; nobody edits its profile, so the code
    // stays the source of truth (an older row without pictures catches up).
    await prisma.profile.update({ where: { userId: user.id }, data: { photos: persona.photos } });
  }
  if (!profile) {
    await prisma.profile.create({
      data: {
        userId: user.id,
        height: persona.height,
        hobbies: persona.hobbies,
        partnerPreferences: persona.partnerPreferences,
        psychologicalSummary: persona.psychologicalSummary,
        fridayVibeText: persona.fridayVibeText,
        vibeFocusText: persona.vibeFocusText,
        energyAxis: persona.energyAxis,
        orientationAxis: persona.orientationAxis,
        anchorTags: persona.anchorTags,
        photos: persona.photos,
        vibeExtractedAt: now,
        relationshipIntents: ["open", "falling"],
        eloScore: 520,
        eloSeededAt: now,
        homeCity: market.city,
        homeCityKey: market.cityKey,
        homeCountryCode: market.countryCode,
        latitude: market.latitude,
        longitude: market.longitude,
        locationUpdatedAt: now,
        timeZone: cityKeyToTimeZone(market.cityKey),
        embeddingDirty: true,
      },
    });
  }
  return user;
}

function samePaths(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** Keep the reviewer able to pay the date ticket without buying anything. */
export async function ensureAppReviewTickets(userId: string, floor = 2): Promise<void> {
  const balance = await getBalance(userId);
  if (balance >= floor) return;
  // `welcome_gift`, not `store_purchase`: these are not revenue.
  await grantTickets({ userId, count: floor - balance, reason: "welcome_gift" });
}
