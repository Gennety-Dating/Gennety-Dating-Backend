import { randomInt } from "node:crypto";
import { Prisma, prisma, type User } from "@gennety/db";

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
 * Find or create a user keyed by university email. Collisions on the
 * synthetic `telegramId` are retried up to 3 times — the space is 2^53 so
 * the practical collision rate is zero.
 */
export async function findOrCreateMobileUser(email: string): Promise<User> {
  const normalisedEmail = email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalisedEmail } });
  if (existing) {
    if (existing.isEmailVerified) return existing;
    return prisma.user.update({
      where: { id: existing.id },
      // Registration v2: a verified university email IS the student track.
      data: { isEmailVerified: true, registrationTrack: "student" },
    });
  }

  const universityDomain = extractDomain(normalisedEmail);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.user.create({
        data: {
          telegramId: syntheticTelegramId(),
          email: normalisedEmail,
          universityDomain,
          platform: "mobile",
          status: "onboarding",
          onboardingStep: "consent",
          isEmailVerified: true,
          registrationTrack: "student",
        },
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
