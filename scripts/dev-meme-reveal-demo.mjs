#!/usr/bin/env node
/**
 * Dev-only helper (local @gennetytestbot + localhost dev DB only).
 *
 * Walks the Meme Unlock beat (§3.12) by hand, on real Telegram accounts.
 *
 * Nothing here is faked past the seam:
 *
 *  • the picture is uploaded through the DEV bot, so the `file_id` stored is
 *    one this bot can actually resolve later (file_ids are bot-scoped — a
 *    pointer minted anywhere else would fail at reveal time, which is exactly
 *    the failure this script exists to rule out);
 *  • the description is written by the REAL vision pass (`readMemeImage`), so
 *    an unsafe or unreadable image correctly ends up with no pointer and no
 *    offer — the safety property the feature leans on;
 *  • the reveal is FREE. This was a 25⭐ purchase and is not one any more —
 *    charging one person to see what another said about themselves made the
 *    second person inventory. Consent now lives in the humour question's copy.
 *
 * Three modes. To walk the WHOLE feature — capture first, purchase second —
 * run the first two in order:
 *
 *   pnpm dev:meme-unlock --ask      the bot asks the TESTER the humour
 *                                   question for real; he replies with a
 *                                   picture and the ordinary capture path runs
 *                                   (MIME sniff → vision → description +
 *                                   file_id), with no help from this script
 *
 *   pnpm dev:meme-unlock --mirror   plant what he just sent as the PARTNER's
 *                                   answer, stage the date, send the offer —
 *                                   so what he buys back is the picture he
 *                                   chose himself, described by the model in
 *                                   his own words' place
 *
 *   pnpm dev:meme-unlock            no mode: plant `--meme` (a stock photo by
 *                                   default) on the partner and go straight to
 *                                   the offer
 *
 * Usage:
 *   pnpm dev:meme-unlock [--ask | --mirror]
 * Optional:
 *   --tester=782065541 --partner=5986970093 --lang=ru
 *   --meme=<local path|https url>   picture to plant (default: a stock photo)
 *   --solo                          mint the file_id in the tester's own chat
 *   --force                         skip the dev-bot / dev-DB guards
 *
 * Both accounts must exist in the dev DB and have pressed Start on
 * @gennetytestbot once. The dev bot must be RUNNING — this script only stages
 * state and sends cards; the question reply, the tap, the invoice and the
 * settle are all handled by the live bot process.
 */
import { createRequire } from "node:module";
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

const argv = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq === -1 ? [a.slice(2), "true"] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);

const force = argv.get("force") === "true";
const solo = argv.get("solo") === "true";
const askMode = argv.get("ask") === "true";
const mirrorMode = argv.get("mirror") === "true";
const testerTg = BigInt(argv.get("tester") ?? "782065541");
const partnerTg = BigInt(argv.get("partner") ?? "5986970093");
// Deliberately NOT defaulted to "ru". The bot resolves the language of every
// button it draws from `user.language`, so a demo card forced into a different
// language than the tester's own row makes the bot look like it is switching
// languages mid-tap — a bug in the test rig that reads exactly like a bug in
// the product. `--lang` overrides; otherwise `main()` reads the tester's row.
const langFlag = argv.get("lang") ?? null;
let lang = langFlag ?? "en";
const MEME_DEFAULT = "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=800";
const memeRef = argv.get("meme") ?? MEME_DEFAULT;

const OPEN_STATUSES = ["proposed", "negotiating", "negotiating_venue", "scheduled"];

/** Real central-Kyiv venue, so the staged date reads like a real one. */
const VENUE = {
  venueName: "Aroma Kava",
  venueAddress: "vulytsia Khreshchatyk 15, Kyiv",
  venueLat: 50.4472,
  venueLng: 30.5219,
  venueGoogleMapsUri: "https://maps.google.com/?q=50.4472,30.5219",
};

const BRIEF = {
  ru: (name) =>
    "🧪 Тест: показ любимого мема перед свиданием\n\n" +
    `Свидание: ${VENUE.venueName} — Хрещатик 15, через 3 дня.\n` +
    `У ${name} на вопрос про юмор лежит картинка — её описание уже прочитала ` +
    "модель зрения.\n\n" +
    "1️⃣ Ниже придёт карточка-тизер. Она НЕ показывает мем — только то, что он есть.\n" +
    "2️⃣ Жми кнопку → бот сразу пришлёт картинку (и ссылку на ролик, если ответ был ссылкой).\n" +
    "3️⃣ Денег не спросит: функция бесплатная.\n" +
    "4️⃣ Нажми ещё раз — пришлёт снова, это теперь нормально.",
  en: (name) =>
    "🧪 Test: the pre-date meme reveal\n\n" +
    `Date: ${VENUE.venueName} — Khreshchatyk 15, in 3 days.\n` +
    `${name} has a picture on the humour question; the vision pass has already ` +
    "described it.\n\n" +
    "1️⃣ A teaser card lands below. It does NOT show the meme — only that there is one.\n" +
    "2️⃣ Tap the button → the picture arrives (plus the link, if the answer was one).\n" +
    "3️⃣ Nothing is charged: the reveal is free.\n" +
    "4️⃣ Tap again — it re-sends, which is now fine.",
};

const ASK_BRIEF = {
  ru:
    "🧪 Тест, часть 1 из 2 — как мем ПОПАДАЕТ в профиль.\n\n" +
    "Сейчас придёт настоящий вопрос профайлера про юмор.\n\n" +
    "⚠️ Ответь МЕДИА или ССЫЛКОЙ на рил — но не обычным текстом. Пока окно " +
    "ответа открыто, любой другой текст записывается как ответ на вопрос, даже " +
    "если ты просто что-то спрашиваешь.\n\n" +
    "Медиа: фото, стикер, GIF, видео, пересланный мем, картинка файлом. Фото " +
    "читается целиком, остальное — по превью-кадру.\n\n" +
    "Ссылка: TikTok или Instagram Reels, в любом виде — короткая vm./vt., " +
    "шэринговая, полная. Бот прочитает подпись автора и обложку ролика; само " +
    "видео он не качает. Можешь дописать пару слов вокруг ссылки — они уйдут в " +
    "модель как твой комментарий.\n\n" +
    "Дальше всё по-настоящему: проверка типа, модель зрения, ОДНО " +
    "предложение-описание и указатель на файл. Ни картинку, ни видео бот не " +
    "хранит.",
  en:
    "🧪 Test, part 1 of 2 — how a meme GETS IN.\n\n" +
    "The real humour Profiler question is about to arrive. Answer it with a " +
    "picture — send any meme (a caption is fine).\n\n" +
    "Everything downstream is real: the bot sniffs the file type, runs the image " +
    "through the vision model, and stores ONE sentence of description plus a " +
    "pointer to the file — never the picture itself.\n\n" +
    "Once you've answered, tell me and I'll run part 2: the purchase.",
};

const API = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

async function tgJson(method, payload) {
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram ${method} failed: ${json?.description ?? res.status}`);
  }
  return json.result;
}

async function tgForm(method, form) {
  const res = await fetch(`${API()}/${method}`, { method: "POST", body: form });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram ${method} failed: ${json?.description ?? res.status}`);
  }
  return json.result;
}

/** Raw bytes of the picture, for the vision pass. */
async function loadImage(ref) {
  if (/^https?:\/\//.test(ref)) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`Could not fetch ${ref}: ${res.status}`);
    const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    return { buffer: Buffer.from(await res.arrayBuffer()), mime };
  }
  if (!existsSync(ref)) throw new Error(`File not found: ${ref}`);
  const buffer = readFileSync(ref);
  const mime = /\.png$/i.test(ref) ? "image/png" : /\.webp$/i.test(ref) ? "image/webp" : "image/jpeg";
  return { buffer, mime };
}

/**
 * Upload the picture through THIS bot and delete the message, keeping only the
 * file_id — the same mint-and-discard trick `dev-seed-ticket-photos.mjs` uses,
 * and the only way to get a pointer the dev bot can resolve at reveal time.
 */
async function mintFileId(chatId, image) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([image.buffer], { type: image.mime }), "meme.jpg");
  const msg = await tgForm("sendPhoto", form);
  const sizes = msg.photo ?? [];
  const fileId = sizes.length ? sizes[sizes.length - 1].file_id : null;
  if (msg.message_id) {
    await tgJson("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
  }
  if (!fileId) throw new Error("sendPhoto returned no photo sizes");
  return fileId;
}

/** Write the meme onto the partner's humour answer, exactly as the real capture path would. */
async function stagePartnerAnswer(
  prisma,
  cycleId,
  { partnerId, questionId, description, fileId, kind, sourceUrl, now },
) {
  // `sourceUrl` is written on BOTH branches, null included: staging a plain
  // picture over a previous link answer must clear the link, or the reveal
  // would offer a video this answer is no longer about — the same rule
  // `recordProfilerAnswer` follows.
  await prisma.profilerAnswer.upsert({
    where: { userId_questionId: { userId: partnerId, questionId } },
    create: {
      userId: partnerId,
      questionId,
      priority: "high",
      answerText: description,
      memeFileId: fileId,
      memeKind: kind,
      memeSourceUrl: sourceUrl ?? null,
      answeredAt: now,
      skipped: false,
      cycleId,
    },
    update: {
      answerText: description,
      memeFileId: fileId,
      memeKind: kind,
      memeSourceUrl: sourceUrl ?? null,
      answeredAt: now,
      skipped: false,
    },
  });
}

/** A clean `scheduled` date between the two, then the brief and the real offer card. */
async function stageDateAndCard(prisma, api, sendMemeCard, { tester, partner, now }) {
  const stale = await prisma.match.findMany({
    where: {
      status: { in: OPEN_STATUSES },
      OR: [
        { userAId: { in: [tester.id, partner.id] } },
        { userBId: { in: [tester.id, partner.id] } },
      ],
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
    where: { userId: { in: [tester.id, partner.id] } },
    data: { lastMatchedAt: null },
  });

  const agreedTime = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const match = await prisma.match.create({
    data: {
      userAId: tester.id,
      userBId: partner.id,
      status: "scheduled",
      acceptedByA: true,
      acceptedByB: true,
      dispatchedAt: now,
      agreedTime,
      ...VENUE,
    },
    select: { id: true },
  });

  // A fresh match id carries no entitlement, but clear it anyway so a re-run
  // against a hand-made match is sellable again.
  const brief = (BRIEF[lang] ?? BRIEF.en)(partner.firstName ?? "");
  await api.sendMessage(Number(testerTg), brief);
  const sent = await sendMemeCard(api, Number(testerTg), tester.id, match.id, lang);
  return { matchId: match.id, sent };
}

async function main() {
  if (askMode && mirrorMode) throw new Error("Pick one of --ask / --mirror, not both.");
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(
      `Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}). Pass --force.`,
    );
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database. Pass --force.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");
  if (process.env.MEME_REVEAL_ENABLED !== "true") {
    throw new Error(
      "MEME_REVEAL_ENABLED is not 'true' — the card would be suppressed. Set it in .env.local and restart the bot.",
    );
  }

  const { prisma } = await import("@gennety/db");
  // grammy is the bot's dep, not the root's — resolve it from apps/bot so this
  // script and the live handler share one module instance.
  const requireFromBot = createRequire(resolve(root, "apps/bot/package.json"));
  const { Bot } = await import(requireFromBot.resolve("grammy"));
  const { readMemeImage } = await import("../apps/bot/src/services/vision/read-meme.js");
  const { profilerCycleId, startProfilerBatch } = await import(
    "../apps/bot/src/services/profiler.js"
  );
  const { profilerQuestionBank } = await import("@gennety/shared");
  const { sendMemeCard, memeRevealFeatureLive } = await import(
    "../apps/bot/src/services/meme-unlock.js"
  );
  const api = new Bot(process.env.BOT_TOKEN).api;

  if (!memeRevealFeatureLive()) {
    throw new Error("memeRevealFeatureLive() is false — check MEME_REVEAL_ENABLED.");
  }

  const select = { id: true, firstName: true, gender: true, language: true };
  const tester = await prisma.user.findUnique({ where: { telegramId: testerTg }, select });
  const partner = await prisma.user.findUnique({ where: { telegramId: partnerTg }, select });
  if (!tester) throw new Error(`Tester (tg=${testerTg}) not found in the dev DB.`);
  if (!partner) throw new Error(`Partner (tg=${partnerTg}) not found in the dev DB.`);
  if (tester.id === partner.id) throw new Error("Tester and partner must be different accounts.");
  if (!langFlag) {
    lang = tester.language ?? "en";
    console.log(`Language: ${lang} (from ${tester.firstName}'s row; pass --lang to override).`);
  }

  const now = new Date();
  const cycleId = profilerCycleId(now);
  const humourFor = (gender) => (gender === "male" ? "m_humor" : "f_humor");
  const partnerQuestionId = humourFor(partner.gender);
  const testerQuestionId = humourFor(tester.gender);

  // ── ASK MODE ─────────────────────────────────────────────────────────────
  // Make the bot ask the TESTER the humour question for real, so the capture
  // side can be walked too: his picture then goes through the ordinary router →
  // MIME sniff → vision → upsert path, with no help from this script.
  //
  // `selectNextProfilerQuestion` picks the first bank question with no row at
  // all, so forcing one means giving every earlier question a row. They are
  // seeded as an already-returned skip — the state a real "Skip" leaves — which
  // costs nothing: skip suppression is per drop cycle, so they all become
  // askable again next cycle on their own. Dev DB only, by the guards above.
  if (askMode) {
    const bank = profilerQuestionBank(tester.gender ?? null);
    const cut = bank.findIndex((q) => q.id === testerQuestionId);
    if (cut === -1) throw new Error(`${testerQuestionId} is not in the ${tester.gender} bank.`);

    const existing = await prisma.profilerAnswer.findMany({
      where: { userId: tester.id },
      select: { questionId: true },
    });
    const have = new Set(existing.map((r) => r.questionId));
    const seed = bank.slice(0, cut).filter((q) => !have.has(q.id));
    if (seed.length) {
      await prisma.profilerAnswer.createMany({
        data: seed.map((q) => ({
          userId: tester.id,
          questionId: q.id,
          priority: q.priority,
          skipped: true,
          skipReturned: true,
          cycleId,
        })),
        skipDuplicates: true,
      });
    }
    // The humour question itself must look never-asked, or pass 1 walks past it.
    await prisma.profilerAnswer.deleteMany({
      where: { userId: tester.id, questionId: testerQuestionId },
    });
    // A stale active question would make the batch opener return "paused".
    await prisma.profile.update({
      where: { userId: tester.id },
      data: {
        profilerActiveQuestionId: null,
        profilerAnswerWindowUntil: null,
        profilerQuestionMessageId: null,
        profilerNextAt: null,
      },
    });

    await api.sendMessage(Number(testerTg), ASK_BRIEF[lang] ?? ASK_BRIEF.en);
    const outcome = await startProfilerBatch(api, tester.id, now);

    console.log("\n── RESULT ──");
    console.log(
      JSON.stringify(
        {
          mode: "ask",
          tester: { tg: testerTg.toString(), name: tester.firstName },
          questionId: testerQuestionId,
          seededSkips: seed.map((q) => q.id),
          startProfilerBatch: outcome,
        },
        null,
        2,
      ),
    );
    console.log(
      outcome === "sent"
        ? "\n✅ Question sent. Reply to it in @gennetytestbot with a picture — the\n" +
            "   capture path (MIME sniff → vision → description + file_id) runs for real.\n" +
            "   Then: pnpm dev:meme-unlock --mirror"
        : `\n⚠️  startProfilerBatch returned '${outcome}' — nothing was asked.`,
    );
    await prisma.$disconnect();
    return;
  }

  // ── The meme to sell ─────────────────────────────────────────────────────
  let description;
  let fileId;
  let kind = "photo";
  /** Only a mirrored link answer has one; a staged picture never does. */
  let sourceUrl = null;

  if (mirrorMode) {
    // Hand the tester his OWN meme back as the partner's answer. The file_id
    // was minted by this same bot when he sent it, so it resolves on the
    // reveal, and the description is the one the model wrote about HIS picture,
    // so the advice line is generated off content he chose. He cannot buy his
    // own meme — the offer is always about the other side — which is exactly
    // why it has to be copied across rather than pointed at.
    const own = await prisma.profilerAnswer.findFirst({
      where: {
        userId: tester.id,
        questionId: testerQuestionId,
        skipped: false,
        memeFileId: { not: null },
        answerText: { not: null },
      },
      select: {
        memeFileId: true,
        memeKind: true,
        answerText: true,
        memeSourceUrl: true,
      },
      orderBy: { answeredAt: "desc" },
    });
    if (!own) {
      throw new Error(
        `${tester.firstName} has no image-backed '${testerQuestionId}' answer yet.\n` +
          "   Run `pnpm dev:meme-unlock --ask` first and reply with a picture.\n" +
          "   (A typed answer, or one whose image the vision pass refused, leaves no\n" +
          "   pointer on purpose — that is the safety property, not a bug.)",
      );
    }
    description = own.answerText;
    fileId = own.memeFileId;
    kind = own.memeKind ?? "photo";
    sourceUrl = own.memeSourceUrl ?? null;
    console.log(`Mirroring ${tester.firstName}'s own meme → ${partner.firstName}: "${description}"`);
    if (sourceUrl) console.log(`  …captured from a link, so the reveal will also send: ${sourceUrl}`);
  } else {
    const image = await loadImage(memeRef);
    const read = await readMemeImage(image, { language: partner.language ?? "en" });
    if (!read.ok) {
      throw new Error(
        `Vision pass returned '${read.error}' — no description, so there is nothing to sell.\n` +
          (read.error === "unsafe"
            ? "   That is the feature working: an unsafe image never gets a pointer. Try another --meme."
            : "   Check OPENAI_API_KEY, or try another --meme."),
      );
    }
    description = read.description;
    console.log(`Vision (${read.model}) → "${description}"`);

    const mintChat = solo ? testerTg : partnerTg;
    try {
      fileId = await mintFileId(mintChat, image);
    } catch (err) {
      if (solo) throw err;
      console.warn(
        `⚠️  Could not mint via the partner's chat (${err.message}) — falling back to the\n` +
          "   tester's own chat, so the reveal will not be a surprise.",
      );
      fileId = await mintFileId(testerTg, image);
    }
    console.log(`file_id minted in chat ${solo ? testerTg : mintChat}: ${fileId.slice(0, 18)}…`);
  }

  await stagePartnerAnswer(prisma, cycleId, {
    partnerId: partner.id,
    questionId: partnerQuestionId,
    description,
    fileId,
    kind,
    sourceUrl,
    now,
  });

  const { matchId, sent } = await stageDateAndCard(prisma, api, sendMemeCard, {
    tester,
    partner,
    now,
  });

  console.log("\n── RESULT ──");
  console.log(
    JSON.stringify(
      {
        mode: mirrorMode ? "mirror" : "stock",
        matchId,
        tester: { tg: testerTg.toString(), name: tester.firstName },
        partner: { tg: partnerTg.toString(), name: partner.firstName, questionId: partnerQuestionId },
        description,
        kind,
        sourceUrl,
        cardSent: sent,
      },
      null,
      2,
    ),
  );
  if (!sent) {
    console.log(
      "\n⚠️  The offer card did NOT go out. Either the tester has never pressed Start on\n" +
        "   @gennetytestbot, or something upstream suppressed it (feature flag, missing pointer).",
    );
  } else {
    console.log(
      "\n✅ Staged. Tap the button in @gennetytestbot — the LIVE bot process handles the\n" +
        "   invoice, the settle and the reveal, so make sure it is running.",
    );
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("MEME-UNLOCK-DEMO FAILED:", err.message);
  process.exit(1);
});
