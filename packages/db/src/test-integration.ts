/**
 * Integration test helpers — uses a REAL Prisma client against the
 * Docker-based test database (docker-compose.test.yml).
 *
 * Usage in *.integration.test.ts:
 *
 *   import { integrationPrisma, cleanDatabase } from "@gennety/db/test-integration";
 *
 *   beforeEach(async () => { await cleanDatabase(); });
 *   afterAll(async () => { await integrationPrisma.$disconnect(); });
 */

import { PrismaClient } from "@prisma/client";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://gennety:gennety@localhost:5433/gennety_test";

// Safety check — refuse to run against production
if (
  !DATABASE_URL.includes("localhost") &&
  !DATABASE_URL.includes("127.0.0.1") &&
  !DATABASE_URL.includes("gennety_test")
) {
  throw new Error(
    `[SAFETY] Integration test DATABASE_URL does not look local/test:\n  ${DATABASE_URL}\n` +
      "Set DATABASE_URL to the docker-compose.test.yml connection string.",
  );
}

export const integrationPrisma = new PrismaClient({
  datasourceUrl: DATABASE_URL,
});

/**
 * Truncate all tables (preserving schema). Use in `beforeEach` for full
 * isolation between tests.
 *
 * Order respects foreign key constraints.
 */
export async function cleanDatabase(): Promise<void> {
  await integrationPrisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      bot_sessions,
      email_otps,
      matches,
      profiles,
      users,
      system_knowledge
    CASCADE
  `);
}

// ---------------------------------------------------------------------------
// Seed helpers — minimal factories for integration tests
// ---------------------------------------------------------------------------

let userSeq = 100_000;

interface SeedUserOpts {
  telegramId?: bigint;
  email?: string;
  universityDomain?: string;
  firstName?: string;
  gender?: "male" | "female";
  preference?: "men" | "women" | "both";
  age?: number;
  status?: "onboarding" | "active" | "paused";
  onboardingStep?: "consent" | "language" | "conversational" | "completed";
  verificationStatus?:
    | "unverified"
    | "pending"
    | "pending_review"
    | "verified"
    | "rejected";
  verificationSkippedAt?: Date | null;
  /// Registration v2 contact rails. Email defaults to verified (the pre-fork
  /// invariant: every completed user had a verified university email); pass
  /// `false` + `phoneVerifiedAt` to seed a general-track (phone-only) user.
  isEmailVerified?: boolean;
  phoneVerifiedAt?: Date | null;
  registrationTrack?: "student" | "general" | null;
}

export async function seedUser(opts: SeedUserOpts = {}) {
  const seq = userSeq++;
  return integrationPrisma.user.create({
    data: {
      telegramId: opts.telegramId ?? BigInt(seq),
      email: opts.email ?? `user${seq}@stanford.edu`,
      universityDomain: opts.universityDomain ?? "stanford.edu",
      firstName: opts.firstName ?? `User${seq}`,
      gender: opts.gender ?? "male",
      preference: opts.preference ?? "women",
      age: opts.age ?? 22,
      status: opts.status ?? "active",
      onboardingStep: opts.onboardingStep ?? "completed",
      verificationStatus: opts.verificationStatus ?? "unverified",
      verificationSkippedAt: opts.verificationSkippedAt ?? null,
      isEmailVerified: opts.isEmailVerified ?? true,
      phoneVerifiedAt: opts.phoneVerifiedAt ?? null,
      registrationTrack: opts.registrationTrack ?? null,
      language: "en",
    },
  });
}

interface SeedProfileOpts {
  userId: string;
  psychologicalSummary?: string;
  photos?: string[];
  eloScore?: number;
}

export async function seedProfile(opts: SeedProfileOpts) {
  return integrationPrisma.profile.create({
    data: {
      userId: opts.userId,
      psychologicalSummary:
        opts.psychologicalSummary ?? "Curious analytical thinker.",
      photos: opts.photos ?? ["photo_1"],
      eloScore: opts.eloScore ?? 500,
    },
  });
}
