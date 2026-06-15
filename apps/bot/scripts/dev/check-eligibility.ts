/**
 * Dev-only: dump the matching-eligibility fields for given telegram ids so we
 * can see WHY a pair would or wouldn't match before firing the batch.
 * Read-only. Dev-DB guarded.
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const url = process.env.DATABASE_URL ?? "";
if (!(url.includes("5434") && url.includes("gennety_dev"))) {
  console.error("[check-eligibility] refusing: not the dev DB");
  process.exit(1);
}

const ids = process.argv.slice(2).map((a) => BigInt(a.trim()));
const { prisma } = await import("@gennety/db");

for (const tgId of ids) {
  const u = await prisma.user.findUnique({
    where: { telegramId: tgId },
    select: {
      id: true,
      firstName: true,
      status: true,
      onboardingStep: true,
      gender: true,
      preference: true,
      isEmailVerified: true,
      universityDomain: true,
      verificationStatus: true,
      profile: {
        select: {
          homeCityKey: true,
          latitude: true,
          longitude: true,
          eloScore: true,
          lastMatchedAt: true,
          standbyCount: true,
        },
      },
    },
  });
  if (!u) {
    console.log(`\n— ${tgId}: NOT FOUND`);
    continue;
  }
  // embedding lives in a vector column — check presence via raw query
  const emb = await prisma.$queryRaw<{ has: boolean }[]>`
    SELECT (embedding IS NOT NULL) AS has FROM profiles WHERE user_id = ${u.id}::uuid`;
  console.log(`\n— ${tgId}  (${u.firstName})  id=${u.id}`);
  console.log(`  status=${u.status}  step=${u.onboardingStep}`);
  console.log(`  gender=${u.gender}  preference=${u.preference}`);
  console.log(`  emailVerified=${u.isEmailVerified}  domain=${u.universityDomain}`);
  console.log(`  verificationStatus=${u.verificationStatus}`);
  console.log(`  homeCityKey=${u.profile?.homeCityKey}  lat=${u.profile?.latitude}  lng=${u.profile?.longitude}`);
  console.log(`  embedding=${emb[0]?.has ? "present" : "MISSING"}  elo=${u.profile?.eloScore}  lastMatchedAt=${u.profile?.lastMatchedAt ?? "null"}  standby=${u.profile?.standbyCount}`);
}

await prisma.$disconnect();
