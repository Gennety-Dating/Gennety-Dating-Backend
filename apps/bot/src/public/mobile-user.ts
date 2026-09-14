import { randomInt } from "node:crypto";
import { Prisma, prisma, type User } from "@gennety/db";
import { restoreSafetyHistoryAfterAttach } from "../services/safety-tombstone.js";
import { detachUnverifiedEmail, isUniqueViolation } from "../services/verified-email.js";

/**
 * Extract the domain portion of an email (everything after `@`, lowercased).
 * Assumes the caller has already validated the string via `isUniversityEmail`.
 */
export function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return email.slice(at + 1).toLowerCase();
}

/**
 * Mint a synthetic negative Telegram ID for a mobile-first user.
 *
 * Telegram never issues negative IDs, so a negative value both (a) satisfies
 * the schema's `@unique` constraint without colliding with real bot users
 * and (b) acts as a sentinel for workers that target Telegram (`platform`
 * is the canonical check, but `telegramId: { gt: 0 }` also works).
 *
 * Stays within JS safe-integer range so `Number(user.telegramId)` in existing
 * bot code doesn't lose precision if it ever leaks through. `randomInt` caps
 * its range at 2^48, which is still ~281 trillion slots — collision-free.
 */
const SYNTHETIC_ID_MAX = 2 ** 48;

function syntheticTelegramId(): bigint {
  return -BigInt(randomInt(1, SYNTHETIC_ID_MAX));
}

/**
 * Find or create a user keyed by university email — the native login rail.
 * The caller has just verified the code, so the address is proven HERE.
 *
 * Only a row that proved the address itself is signed into. A row that merely
 * carries it unverified is a leftover of the old request-time write (or an
 * attempt to squat it, audit A13-C1): adopting it handed the real owner's
 * first sign-in to whoever controls that row through Telegram. Such a row
 * loses the address, and the person who just proved the mailbox gets a fresh
 * account of their own.
 *
 * Collisions on the synthetic `telegramId` are retried up to 3 times — the
 * space is 2^48 so the practical collision rate is zero.
 */
export async function findOrCreateMobileUser(email: string): Promise<User> {
  const normalisedEmail = email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalisedEmail } });
  if (existing?.isEmailVerified) return existing;
  if (existing) await detachUnverifiedEmail(normalisedEmail, null);

  let created: User;
  try {
    created = await createMobileUserWithRetry({
      email: normalisedEmail,
      universityDomain: extractDomain(normalisedEmail),
      isEmailVerified: true,
      registrationTrack: "student",
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // The address was taken between our read and the insert. The only rows
    // that can hold it now are ones that proved it a moment ago — a double-tap
    // on verify, or the same person finishing on the Telegram rail — and this
    // request proved the same mailbox, so that account is theirs. An
    // unverified holder is never adopted, whatever the timing — that is the
    // whole fix — so it surfaces as the error it is.
    const winner = await prisma.user.findUnique({ where: { email: normalisedEmail } });
    if (winner?.isEmailVerified) return winner;
    throw err;
  }
  // The request that created the row restores; a race winner above was
  // restored by its own request.
  return withSafetyHistory(created, "mobile:email-login");
}

/**
 * Find or create a user keyed by verified phone (native-app general track,
 * Registration v2). The number reaching this point has just passed the
 * Gateway/Twilio code check, so `phoneVerifiedAt` is stamped on both paths.
 * An existing row (e.g. a Telegram user whose trusted `message.contact`
 * carried the same number) is reused as-is — `phone` is `@unique`, one
 * account per number.
 */
export async function findOrCreateMobileUserByPhone(phone: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    // A Telegram-registered account reached through the native app now lives on
    // both surfaces. Without this the row stays `telegram` and channel-aware
    // helpers never consider APNs for them. Mirror of the Telegram-side login
    // in `services/account-linking.ts`, which flips `mobile` → `both`.
    const platformPatch =
      existing.platform === "telegram" ? { platform: "both" as const } : {};
    if (existing.phoneVerifiedAt) {
      if (Object.keys(platformPatch).length === 0) return existing;
      return prisma.user.update({
        where: { id: existing.id },
        data: platformPatch,
      });
    }
    const verified = await prisma.user.update({
      where: { id: existing.id },
      data: {
        phoneVerifiedAt: new Date(),
        ...platformPatch,
        // Never rewrite an existing track (a student stays a student); only
        // fill the gap for pre-fork legacy rows that somehow carry a phone.
        ...(existing.registrationTrack ? {} : { registrationTrack: "general" }),
      },
    });
    return withSafetyHistory(verified, "mobile:phone-login");
  }

  const created = await createMobileUserWithRetry({
    phone,
    phoneVerifiedAt: new Date(),
    registrationTrack: "general",
  });
  return withSafetyHistory(created, "mobile:phone-login");
}

export type TelegramLoginResolution =
  | { kind: "resolved"; user: User }
  /**
   * The verified number belongs to one account and this Telegram id to
   * another. Both are real people's rows; merging them is a support decision,
   * exactly like the Telegram-side `manual-merge` (services/account-linking.ts).
   */
  | { kind: "conflict" };

/**
 * Find or create the account behind a verified Telegram ID token.
 *
 * This is the join that makes the bot and the app ONE product: someone who has
 * been talking to @gennetybot for months and then installs the app must land in
 * their own profile, not an empty registration.
 *
 * Resolution order, strictest evidence first:
 *   1. `telegramId` — the identity Telegram just proved. Exact, so it wins.
 *   2. The verified phone — the cross-rail login key (`User.phone` is unique
 *      and PRODUCT_SPEC §1.1 already treats it as identity on both rails).
 *      Matching here is what links an app account created by SMS to the same
 *      human's Telegram identity.
 *   3. Otherwise a new account.
 *
 * `platform` is handled conservatively and deliberately: a brand-new row stays
 * `mobile` even though we know a REAL Telegram id for it. A bot cannot message
 * someone who never pressed Start, so promoting them to `both` would aim
 * notifications at a channel that silently 403s. `/start` promotes them later,
 * when the bot genuinely can reach them.
 */
export async function findOrCreateUserByTelegramLogin(params: {
  telegramId: bigint;
  phone: string | null;
  username: string | null;
}): Promise<TelegramLoginResolution> {
  const { telegramId, phone, username } = params;

  const byTelegram = await prisma.user.findUnique({ where: { telegramId } });
  if (byTelegram) {
    if (phone && byTelegram.phone && byTelegram.phone !== phone) {
      // The number moved to a different Telegram account (recycled carrier
      // number, or a re-registered account). Not ours to guess.
      const phoneOwner = await prisma.user.findUnique({ where: { phone } });
      if (phoneOwner && phoneOwner.id !== byTelegram.id) return { kind: "conflict" };
    }
    const attachesPhone = Boolean(phone && !byTelegram.phone);
    const user = await prisma.user.update({
      where: { id: byTelegram.id },
      data: {
        // A Telegram-registered account now also using the app is reachable on
        // both surfaces — the mirror of `findOrCreateMobileUserByPhone`.
        ...(byTelegram.platform === "telegram" ? { platform: "both" as const } : {}),
        ...(username && byTelegram.telegramUsername !== username
          ? { telegramUsername: username }
          : {}),
        // Telegram vouched for the number, so it satisfies the general track's
        // contact gate — but never overwrite a number already on file.
        ...(phone && !byTelegram.phone
          ? {
              phone,
              phoneVerifiedAt: new Date(),
              ...(byTelegram.registrationTrack ? {} : { registrationTrack: "general" }),
            }
          : {}),
      },
    });
    return {
      kind: "resolved",
      user: attachesPhone ? await withSafetyHistory(user, "mobile:telegram-login") : user,
    };
  }

  if (phone) {
    const byPhone = await prisma.user.findUnique({ where: { phone } });
    if (byPhone) {
      // The row holds a synthetic negative id (app-first) or a real one that
      // is NOT this token's — the latter was already claimed by step 1, so it
      // can only be the synthetic case. Take the real identity.
      if (byPhone.telegramId > 0n) return { kind: "conflict" };
      const user = await prisma.user.update({
        where: { id: byPhone.id },
        data: {
          telegramId,
          ...(username ? { telegramUsername: username } : {}),
          ...(byPhone.phoneVerifiedAt ? {} : { phoneVerifiedAt: new Date() }),
          ...(byPhone.registrationTrack ? {} : { registrationTrack: "general" as const }),
        },
      });
      return { kind: "resolved", user: await withSafetyHistory(user, "mobile:telegram-login") };
    }
  }

  const user = await prisma.user.create({
    data: {
      telegramId,
      platform: "mobile",
      status: "onboarding",
      onboardingStep: "consent",
      ...(username ? { telegramUsername: username } : {}),
      ...(phone
        ? {
            phone,
            phoneVerifiedAt: new Date(),
            registrationTrack: "general" as const,
          }
        : {}),
    },
  });
  return { kind: "resolved", user: await withSafetyHistory(user, "mobile:telegram-login") };
}

/**
 * Restore a deleted account's safety history onto `user` after an identity was
 * attached to it (A13-H14), and hand back the row as it now stands — the login
 * response serializes it, so a restored ban must be in what the app is told.
 * A failed restore is alerted inside `restoreSafetyHistoryAfterAttach` and the
 * login continues with the row as it was.
 */
async function withSafetyHistory(user: User, source: string): Promise<User> {
  const restored = await restoreSafetyHistoryAfterAttach(user.id, source);
  if (!restored?.applied) return user;
  return (await prisma.user.findUnique({ where: { id: user.id } })) ?? user;
}

/**
 * Create a mobile-platform user with a synthetic negative `telegramId`,
 * retrying on the (practically impossible) id collision. Shared by the
 * email- and phone-track creation paths.
 */
async function createMobileUserWithRetry(
  data: Prisma.UserCreateInput extends never ? never : Record<string, unknown>,
): Promise<User> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.user.create({
        data: {
          telegramId: syntheticTelegramId(),
          platform: "mobile",
          status: "onboarding",
          onboardingStep: "consent",
          ...data,
        } as Prisma.UserUncheckedCreateInput,
      });
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        Array.isArray((err.meta as { target?: string[] } | undefined)?.target) &&
        (err.meta as { target: string[] }).target.includes("telegram_id")
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Failed to allocate a unique synthetic telegramId after 3 attempts");
}
