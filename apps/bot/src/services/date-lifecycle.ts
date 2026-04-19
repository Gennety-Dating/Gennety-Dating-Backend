import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language, DATE_ALERT_HOURS, FEEDBACK_DELAY_HOURS, generateIceBreakersPrompt } from "@gennety/shared";
import { callOpenAIText } from "./openai.js";

/**
 * Date lifecycle cron — runs on a fixed interval (e.g. every 2 minutes).
 *
 * Three responsibilities (PRODUCT_SPEC.md §Phase 4):
 *   1. **Ice-breakers**: 3h before `agreedTime`, send AI-generated
 *      conversation starters to both users.
 *   2. **Emergency window**: at the same 3h mark, notify both users
 *      the emergency cancellation button is now available.
 *   3. **Feedback prompt**: 24h after `agreedTime`, ask both users
 *      how the date went.
 *
 * Each action is idempotent: tracked by DB flags so it's safe to
 * retry on failure or if the tick interval overlaps.
 */

/** Static ice-breaker topics — swap with an LLM call later. */
const ICEBREAKER_TOPICS_EN = [
  "What's the most random thing you've done on a whim?",
  "If you could grab dinner with anyone — dead or alive — who?",
  "What's something you want to learn this year?",
];
const ICEBREAKER_TOPICS_RU = [
  "Что самое рандомное ты делал на импульсе?",
  "С кем бы ты поужинал — из любой эпохи?",
  "Чему хочешь научиться в этом году?",
];
const ICEBREAKER_TOPICS_UK = [
  "Що найбільш рандомне ти робив на імпульсі?",
  "З ким би ти повечеряв — з будь-якої епохи?",
  "Чого хочеш навчитись цього року?",
];

function icebreakerTopicsFallback(lang: Language): string[] {
  if (lang === "ru") return ICEBREAKER_TOPICS_RU;
  if (lang === "uk") return ICEBREAKER_TOPICS_UK;
  return ICEBREAKER_TOPICS_EN;
}

/**
 * Generate personalised ice-breakers using the LLM. Falls back to the
 * static topic lists when the API is unavailable or returns empty.
 */
async function generatePersonalisedIceBreakers(
  userFirstName: string,
  matchFirstName: string,
  userSummary: string | null,
  matchSummary: string | null,
  lang: Language,
): Promise<string[]> {
  const systemPrompt = generateIceBreakersPrompt({
    userFirstName,
    matchFirstName,
    userSummary,
    matchSummary,
    language: lang,
  });

  const text = await callOpenAIText(systemPrompt, "Generate the 3 conversation starters now.", {
    maxTokens: 300,
  });

  if (!text) return icebreakerTopicsFallback(lang);

  // Parse numbered lines: "1. ...", "2. ...", "3. ..."
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);

  return lines.length >= 3 ? lines.slice(0, 3) : icebreakerTopicsFallback(lang);
}

export interface DateLifecycleResult {
  icebreakers: number;
  emergencies: number;
  feedbacks: number;
}

/**
 * Single lifecycle tick. Returns counts for logging / testing.
 */
export async function runDateLifecycleTick(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<DateLifecycleResult> {
  const result: DateLifecycleResult = { icebreakers: 0, emergencies: 0, feedbacks: 0 };

  // 1 & 2. Ice-breakers + Emergency window — 3h before agreed_time
  const alertThreshold = new Date(now.getTime() + DATE_ALERT_HOURS * 60 * 60 * 1000);

  const upcomingDates = await prisma.match.findMany({
    where: {
      status: "scheduled",
      agreedTime: { lte: alertThreshold },
      icebreakersSentAt: null,
    },
    select: {
      id: true,
      agreedTime: true,
      userA: { select: { id: true, telegramId: true, language: true, firstName: true } },
      userB: { select: { id: true, telegramId: true, language: true, firstName: true } },
    },
  });

  for (const match of upcomingDates) {
    const langA = (match.userA.language ?? "en") as Language;
    const langB = (match.userB.language ?? "en") as Language;

    // Fetch profile summaries for personalised ice-breakers
    const [profileA, profileB] = await Promise.all([
      prisma.profile.findUnique({ where: { userId: match.userA.id }, select: { psychologicalSummary: true } }),
      prisma.profile.findUnique({ where: { userId: match.userB.id }, select: { psychologicalSummary: true } }),
    ]);

    const nameA = match.userA.firstName ?? "User";
    const nameB = match.userB.firstName ?? "User";
    const summaryA = profileA?.psychologicalSummary ?? null;
    const summaryB = profileB?.psychologicalSummary ?? null;

    // Generate personalised ice-breakers via LLM (falls back to static)
    const [topicsForA, topicsForB] = await Promise.all([
      generatePersonalisedIceBreakers(nameA, nameB, summaryA, summaryB, langA),
      generatePersonalisedIceBreakers(nameB, nameA, summaryB, summaryA, langB),
    ]);

    const topicsAFormatted = topicsForA.map((q, i) => `${i + 1}. ${q}`).join("\n");
    const topicsBFormatted = topicsForB.map((q, i) => `${i + 1}. ${q}`).join("\n");

    const msgA = t(langA, "icebreakerIntro") + topicsAFormatted;
    const msgB = t(langB, "icebreakerIntro") + topicsBFormatted;

    // Emergency cancellation button
    const emergKbA = new InlineKeyboard().text(t(langA, "emergencyBtn"), `emerg:start:${match.id}`);
    const emergKbB = new InlineKeyboard().text(t(langB, "emergencyBtn"), `emerg:start:${match.id}`);

    await Promise.all([
      api.sendMessage(Number(match.userA.telegramId), msgA),
      api.sendMessage(Number(match.userB.telegramId), msgB),
      api.sendMessage(Number(match.userA.telegramId), t(langA, "emergencyUnlocked"), {
        reply_markup: emergKbA,
        parse_mode: "Markdown",
      }),
      api.sendMessage(Number(match.userB.telegramId), t(langB, "emergencyUnlocked"), {
        reply_markup: emergKbB,
        parse_mode: "Markdown",
      }),
    ]);

    await prisma.match.update({
      where: { id: match.id },
      data: {
        icebreakersSentAt: now,
        iceBreakersA: topicsForA,
        iceBreakersB: topicsForB,
      },
    });

    result.icebreakers++;
    result.emergencies++;
  }

  // 3. Feedback prompt — 24h after agreed_time
  const feedbackThreshold = new Date(now.getTime() - FEEDBACK_DELAY_HOURS * 60 * 60 * 1000);

  const pastDates = await prisma.match.findMany({
    where: {
      status: { in: ["scheduled", "completed"] },
      agreedTime: { lte: feedbackThreshold },
      OR: [{ feedbackByA: null }, { feedbackByB: null }],
    },
    select: {
      id: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });

  for (const match of pastDates) {
    const langA = (match.userA.language ?? "en") as Language;
    const langB = (match.userB.language ?? "en") as Language;

    const kbA = new InlineKeyboard().text("📝", `feedback:start:${match.id}`);
    const kbB = new InlineKeyboard().text("📝", `feedback:start:${match.id}`);

    await Promise.all([
      api.sendMessage(Number(match.userA.telegramId), t(langA, "feedbackAsk"), {
        reply_markup: kbA,
      }),
      api.sendMessage(Number(match.userB.telegramId), t(langB, "feedbackAsk"), {
        reply_markup: kbB,
      }),
    ]);

    // Mark as completed so we don't re-send. If it was still `scheduled`,
    // the date has passed — transition it.
    await prisma.match.update({
      where: { id: match.id },
      data: { status: "completed" },
    });

    result.feedbacks++;
  }

  return result;
}
