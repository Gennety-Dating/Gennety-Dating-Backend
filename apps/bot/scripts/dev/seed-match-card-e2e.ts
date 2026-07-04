/**
 * Local-dev only: end-to-end QA of the collage match-card pitch WITHOUT two
 * real onboarded accounts. Upserts:
 *   - user A = a REAL Telegram account (the tester, receives the pitch);
 *   - user B = a synthetic partner with a NEGATIVE telegramId (mobile-style,
 *     so dispatch never tries to DM that side) whose profile photos are the
 *     given local files, uploaded via the dev bot to mint real file_ids
 *     (the upload messages are deleted immediately).
 * Then wipes any prior match between the pair, creates a `proposed` row and
 * dispatches the REAL pitch (cards → stream → decision question).
 *
 * Usage:
 *   pnpm exec tsx scripts/dev/seed-match-card-e2e.ts \
 *     --chat=<testerTelegramId> --photos=/a.png,/b.png[,...]
 *     [--partner-name=Марк] [--partner-age=20]
 *
 * NOT for production: refuses to run unless the bot is @gennetytestbot.
 */
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

const { Api, InputFile } = await import("grammy");
const { prisma } = await import("@gennety/db");
const { dispatchMatches } = await import("../../src/services/dispatch-queue.js");

const args: Record<string, string> = {};
for (const raw of process.argv.slice(2)) {
  if (!raw.startsWith("--")) continue;
  const [k, ...rest] = raw.slice(2).split("=");
  args[k!] = rest.join("=");
}

const chatRaw = args["chat"];
const photosRaw = args["photos"];
if (!chatRaw || !photosRaw) {
  console.error(
    "Usage: seed-match-card-e2e.ts --chat=<telegramId> --photos=/a.png,/b.png[,...]",
  );
  process.exit(1);
}

const testerTgId = BigInt(chatRaw);
const partnerName = args["partner-name"] ?? "Марк";
const partnerAge = Number(args["partner-age"] ?? "20");
// Deterministic synthetic id derived from the tester's, safely negative.
const partnerTgId = -(testerTgId * 100n + 77n);

const PARTNER_SUMMARY =
  "Живой ум, мягкий юмор и спокойная уверенность. Любит вечера с хорошим кино, " +
  "длинные прогулки по городу и настольные игры с друзьями. Учится на третьем курсе, " +
  "подрабатывает репетитором по математике. Ценит честность и лёгкость в общении; " +
  "рядом с ним спокойно и не нужно притворяться. Ищет человека, с которым можно " +
  "разделить и тишину, и смех.";

async function main(): Promise<void> {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    console.error("BOT_TOKEN missing — did .env.local load?");
    process.exit(1);
  }
  const api = new Api(botToken);
  const me = await api.getMe();
  if (me.username && me.username !== "gennetytestbot") {
    console.error(`Refusing to seed: connected bot is @${me.username}, expected @gennetytestbot.`);
    process.exit(2);
  }
  console.log(`Connected as @${me.username}.`);

  // 1. Mint real file_ids for the partner photos by uploading them to the
  //    tester's chat and deleting the messages right away.
  const photoPaths = photosRaw!.split(",").map((p) => resolve(p.trim()));
  const fileIds: string[] = [];
  for (const path of photoPaths) {
    const sent = await api.sendPhoto(Number(testerTgId), new InputFile(readFileSync(path)), {
      disable_notification: true,
    });
    const largest = sent.photo?.[sent.photo.length - 1];
    if (!largest) {
      console.error(`No photo sizes returned for ${path}`);
      process.exit(3);
    }
    fileIds.push(largest.file_id);
    await api.deleteMessage(Number(testerTgId), sent.message_id).catch(() => {});
  }
  console.log(`Minted ${fileIds.length} photo file_id(s).`);

  // 2. Tester row (user A) — upsert to a completed, active state.
  const tgChat = await api.getChat(Number(testerTgId)).catch(() => null);
  const testerName =
    (tgChat && "first_name" in tgChat ? tgChat.first_name : null) ?? "Тестер";
  const userA = await prisma.user.upsert({
    where: { telegramId: testerTgId },
    update: { status: "active", onboardingStep: "completed" },
    create: {
      telegramId: testerTgId,
      firstName: testerName,
      age: 20,
      gender: "female",
      preference: "men",
      language: "ru",
      status: "active",
      onboardingStep: "completed",
      platform: "telegram",
      isEmailVerified: true,
      hasConsented: true,
      termsAccepted: true,
    },
    select: { id: true, firstName: true },
  });
  await prisma.profile.upsert({
    where: { userId: userA.id },
    update: {},
    create: { userId: userA.id, psychologicalSummary: "Тестовый профиль." },
  });

  // 3. Synthetic partner (user B) — negative telegramId so dispatch skips
  //    that side's Telegram sends entirely.
  const userB = await prisma.user.upsert({
    where: { telegramId: partnerTgId },
    update: {
      firstName: partnerName,
      age: partnerAge,
      status: "active",
      onboardingStep: "completed",
      verificationStatus: "verified",
    },
    create: {
      telegramId: partnerTgId,
      firstName: partnerName,
      age: partnerAge,
      gender: "male",
      preference: "women",
      language: "ru",
      status: "active",
      onboardingStep: "completed",
      platform: "mobile",
      isEmailVerified: true,
      hasConsented: true,
      termsAccepted: true,
      verificationStatus: "verified",
    },
    select: { id: true },
  });
  await prisma.profile.upsert({
    where: { userId: userB.id },
    update: { photos: fileIds, psychologicalSummary: PARTNER_SUMMARY },
    create: {
      userId: userB.id,
      photos: fileIds,
      psychologicalSummary: PARTNER_SUMMARY,
      hobbies: ["кино", "настолки", "прогулки"],
    },
  });
  console.log(`Users ready: A=${userA.id} (${userA.firstName}), B=${userB.id} (${partnerName}).`);

  // 4. Fresh proposed match + real dispatch.
  const wiped = await prisma.match.deleteMany({
    where: {
      OR: [
        { userAId: userA.id, userBId: userB.id },
        { userAId: userB.id, userBId: userA.id },
      ],
    },
  });
  if (wiped.count > 0) console.log(`Wiped ${wiped.count} prior match row(s).`);

  const match = await prisma.match.create({
    data: { userAId: userA.id, userBId: userB.id, status: "proposed" },
    select: { id: true },
  });
  console.log(`Created Match ${match.id}; dispatching…`);

  const result = await dispatchMatches(api as never, [match.id], 0);
  if (result.failed > 0) {
    console.error("Dispatch failed:", JSON.stringify(result.errors, null, 2));
    process.exit(5);
  }
  console.log(`\n✅ Pitch dispatched to ${testerTgId}. Match id: ${match.id}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
