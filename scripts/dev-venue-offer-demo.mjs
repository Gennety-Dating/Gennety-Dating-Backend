#!/usr/bin/env node
/**
 * Dev-only helper (local @gennetytestbot + localhost dev DB only).
 *
 * Stages the ONE path through the Venue-Change board (PRODUCT_SPEC §3.7b) that
 * ends in "she initiated, she finalized" — her fork
 * `[Lock it in myself]` / `[Ask him to lock it in 💌]` — so the offer step can be
 * walked manually on two real Telegram accounts.
 *
 * That path is easy to miss by accident: if HE hearts a place SHE already
 * liked, he becomes the finalizer and gets his own pay/decline fork instead.
 * So each side is DM'd its own role instructions in its own language, plus the
 * board button.
 *
 * Unlike `dev-venue-change-demo.mjs` (a theme design pass — same match opened
 * dark + light), this one is about the flow: real roles, real languages, and a
 * board left completely empty so the like → agreement → offer → wish-card
 * sequence runs for real.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-venue-offer-demo.mjs --she=<tg> --he=<tg>
 *
 * Both accounts must already exist in the dev DB and have pressed Start on
 * @gennetytestbot once (otherwise the bot cannot DM them).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnvFile(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);

const force = args.get("force") === "true";
/** Female side — the one who initiates AND finalizes, i.e. makes the offer. */
const sheTg = BigInt(args.get("she") ?? "5986970093");
/** Male side — receives the board invite, then the wish card. */
const heTg = BigInt(args.get("he") ?? "782065541");
const lang = args.get("lang") ?? "ru";

const OPEN_STATUSES = ["proposed", "negotiating", "negotiating_venue", "scheduled"];

// Real central-Kyiv venue so the 3 km alternatives catalog returns genuine
// nearby places to heart (curated-first, Places fallback).
const VENUE = {
  venueName: "Aroma Kava",
  venueAddress: "vulytsia Khreshchatyk 15, Kyiv",
  venueLat: 50.4472,
  venueLng: 30.5219,
  venueGoogleMapsUri: "https://maps.google.com/?q=50.4472,30.5219",
};

const COPY = {
  ru: {
    boardBtn: "📍 Сменить место",
    her: (name, stars) =>
      "🧪 Тест: «Предложить закрепить партнёру»\n\n" +
      `Место свидания: ${VENUE.venueName} — Хрещатик 15.\n\n` +
      "1️⃣ Открой доску и лайкни ЛЮБОЕ место → «Подтвердить».\n" +
      `Ты стала инициатором, ${name} получил приглашение на доску.\n\n` +
      `2️⃣ Дождись, пока ${name} лайкнет ДРУГОЕ место (он не должен лайкать твоё — ` +
      "иначе согласование завершит он, и развилка будет у него).\n\n" +
      "3️⃣ Открой доску снова и лайкни ЕГО место → «Подтвердить».\n" +
      "Согласование завершаешь ты → появится развилка:\n" +
      `«Закрепить самой — ${stars}⭐» / «Предложить закрепить партнёру».\n\n` +
      "4️⃣ Жми «Предложить закрепить партнёру» — это и есть то, что мы меняли:\n" +
      "• сразу спиннер «Отправляем предложение …» (раньше кнопка просто висела);\n" +
      "• затем отдельный экран «Отправили партнёру» с местом и приписками;\n" +
      "• «К местам» вернёт на экран, где твоя кнопка оплаты всё ещё на месте.",
    him: (name, stars) =>
      "🧪 Тест: «Предложить закрепить партнёру» (ты — принимающая сторона)\n\n" +
      `Место свидания: ${VENUE.venueName} — Хрещатик 15.\n\n` +
      `1️⃣ Дождись приглашения от ${name} (или сразу открой доску).\n\n` +
      "2️⃣ Лайкни место, которого у неё НЕТ → «Подтвердить». Совпадения ещё нет — так и надо.\n\n" +
      "3️⃣ Она лайкнет твоё место и завершит согласование — тебе придёт wish-card " +
      "(«Её выбор. Твой ход») с кнопками.\n\n" +
      `4️⃣ Проверить можно оба пути: «Не сейчас» — смена отменяется, остаётся ${VENUE.venueName}; ` +
      `оплата ${stars}⭐ — место меняется у вас обоих.`,
  },
  en: {
    boardBtn: "📍 Change venue",
    her: (name, stars) =>
      "🧪 Test: “Ask them to lock it in”\n\n" +
      `Date venue: ${VENUE.venueName} — Khreshchatyk 15.\n\n` +
      "1️⃣ Open the board, heart ANY place → Confirm. You are now the initiator, " +
      `and ${name} gets a board invite.\n\n` +
      `2️⃣ Wait for ${name} to heart a DIFFERENT place (if he hearts yours, HE finalizes ` +
      "and the fork lands on his side instead).\n\n" +
      "3️⃣ Open the board again and heart HIS place → Confirm. You finalize, so you get the fork: " +
      `“Lock it in myself — ${stars}⭐” / “Ask them to lock it in”.\n\n` +
      "4️⃣ Tap “Ask them to lock it in” — that is the change: an immediate spinner, then a " +
      "success screen saying it reached him, then back to your own pay button.",
    him: (name, stars) =>
      "🧪 Test: “Ask them to lock it in” (you are the receiving side)\n\n" +
      `Date venue: ${VENUE.venueName} — Khreshchatyk 15.\n\n` +
      `1️⃣ Wait for ${name}'s invite (or just open the board).\n\n` +
      "2️⃣ Heart a place she has NOT hearted → Confirm. No overlap yet — that's the point.\n\n" +
      "3️⃣ She then hearts your place and finalizes → you get the wish card with buttons.\n\n" +
      `4️⃣ Both paths are testable: “Not this time” keeps ${VENUE.venueName}; paying ${stars}⭐ ` +
      "changes the venue for both of you.",
  },
};

async function tgCall(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(
      `Telegram ${method} failed: ${json?.description ?? `${res.status} ${res.statusText}`}`,
    );
  }
  return json.result;
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(
      "Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot). Pass --force to override.",
    );
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");
  const webappUrl = process.env.WEBAPP_URL;
  if (!webappUrl?.startsWith("https://")) {
    throw new Error(`WEBAPP_URL must be an https tunnel for web_app buttons; got: ${webappUrl}`);
  }
  if (process.env.VENUE_CHANGE_FEATURE_ENABLED !== "true") {
    console.warn(
      "⚠️  VENUE_CHANGE_FEATURE_ENABLED is not 'true' — the board will render closedReason=feature-disabled.",
    );
  }
  const stars = process.env.VENUE_CHANGE_STARS ?? "150";

  const { prisma } = await import("@gennety/db");
  const token = process.env.BOT_TOKEN;
  const copy = COPY[lang] ?? COPY.en;

  const select = { id: true, firstName: true, gender: true, theme: true, language: true };
  const she = await prisma.user.findUnique({ where: { telegramId: sheTg }, select });
  const he = await prisma.user.findUnique({ where: { telegramId: heTg }, select });
  if (!she) throw new Error(`Female side (tg=${sheTg}) not found in the dev DB.`);
  if (!he) throw new Error(`Male side (tg=${heTg}) not found in the dev DB.`);

  // The offer fork is hetero-only and female-only, so the genders decide whether
  // this staging is even reachable — fix them rather than staging a dead board.
  if (she.gender !== "female") {
    await prisma.user.update({ where: { id: she.id }, data: { gender: "female" } });
    console.log(`Set ${she.firstName} (tg=${sheTg}) gender=female — required for the offer fork.`);
  }
  if (he.gender !== "male") {
    await prisma.user.update({ where: { id: he.id }, data: { gender: "male" } });
    console.log(`Set ${he.firstName} (tg=${heTg}) gender=male — required for the offer fork.`);
  }

  // Clear stale in-flight rows + cooldown so re-runs are clean.
  const stale = await prisma.match.findMany({
    where: {
      status: { in: OPEN_STATUSES },
      OR: [{ userAId: { in: [she.id, he.id] } }, { userBId: { in: [she.id, he.id] } }],
    },
    select: { id: true },
  });
  if (stale.length) {
    await prisma.match.updateMany({
      where: { id: { in: stale.map((m) => m.id) } },
      data: { status: "cancelled" },
    });
    console.log(`Cancelled ${stale.length} stale in-flight match(es).`);
  }
  await prisma.profile.updateMany({
    where: { userId: { in: [she.id, he.id] } },
    data: { lastMatchedAt: null },
  });

  // Straight to a `scheduled` date with the board open. Created directly rather
  // than through `createProposedMatch`, whose in-transaction eligibility re-check
  // (embedding freshness, city, verification) is about real allocation and would
  // just make staging flaky.
  const agreedTime = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // +3 days, well past the T-5h cutoff
  const match = await prisma.match.create({
    data: {
      userAId: she.id,
      userBId: he.id,
      status: "scheduled",
      acceptedByA: true,
      acceptedByB: true,
      dispatchedAt: new Date(),
      agreedTime,
      venueChangeStatus: null,
      ...VENUE,
    },
    select: { id: true },
  });

  const url = (user) =>
    `${webappUrl}/venue-change.html?match=${match.id}&lang=${lang}&theme=${user.theme ?? "dark"}`;
  async function dm(chatId, user, text) {
    try {
      const sent = await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [[{ text: copy.boardBtn, web_app: { url: url(user) } }]],
        },
      });
      return { chatId, messageId: sent.message_id };
    } catch (err) {
      return { chatId, error: err.message };
    }
  }

  const dmHer = await dm(sheTg.toString(), she, copy.her(he.firstName ?? "", stars));
  const dmHim = await dm(heTg.toString(), he, copy.him(she.firstName ?? "", stars));

  console.log("\n── RESULT ──");
  console.log(
    JSON.stringify(
      {
        matchId: match.id,
        venue: VENUE.venueName,
        agreedTime: agreedTime.toISOString(),
        starsPrice: stars,
        she: { tg: sheTg.toString(), name: she.firstName, ...dmHer },
        he: { tg: heTg.toString(), name: he.firstName, ...dmHim },
      },
      null,
      2,
    ),
  );
  for (const [who, res] of [
    [she.firstName, dmHer],
    [he.firstName, dmHim],
  ]) {
    if (res.error) {
      console.log(
        `\n⚠️  Could not DM ${who} (${res.chatId}): ${res.error}\n` +
          "   That account must press Start on @gennetytestbot once first.",
      );
    }
  }
  if (!dmHer.error && !dmHim.error) {
    console.log("\n✅ Both sides staged. Follow the numbered steps in each chat.");
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("VENUE-OFFER-DEMO FAILED:", err.message);
  process.exit(1);
});
