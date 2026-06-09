import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  DATE_ALERT_HOURS,
  FEEDBACK_DELAY_HOURS,
  PRE_DATE_WINGMAN_HOURS,
  generateIceBreakersPrompt,
  generateDateHintsPrompt,
  formatProfilerAnswersBlock,
  scoreProfilerAnswers,
} from "@gennety/shared";
import { env } from "../config.js";
import { callOpenAIText } from "./openai.js";
import { generateAndSaveWingmanHints } from "./wingman-hint.js";
import { sendPushToUser } from "./push.js";
import { sweepExpiredVenueChanges } from "../handlers/matching/venue-change.js";

/**
 * Build the post-date feedback DM keyboard: two stacked buttons, form first.
 * The form opens the Mini App (signed POST to `/v1/feedback/post-date`); the
 * voice button drops the user into `awaiting_feedback` so the next voice
 * note (or typed text) is captured.
 *
 * Inline `web_app` button labels can't carry custom_emoji entities, so the
 * leading glyph in each label is plain Unicode — same constraint we hit on
 * the main menu keyboard (PRODUCT_SPEC.md §2.1).
 */
function buildFeedbackKeyboard(matchId: string, lang: Language): InlineKeyboard {
  const url = `${env.WEBAPP_FEEDBACK_URL}?match=${matchId}&lang=${lang}`;
  return new InlineKeyboard()
    .webApp(t(lang, "feedbackBtnForm"), url)
    .row()
    .text(t(lang, "feedbackBtnVoice"), `feedback:voice:${matchId}`);
}

/**
 * Date lifecycle cron — runs on a fixed interval (e.g. every 2 minutes).
 *
 * Three responsibilities (PRODUCT_SPEC.md §Phase 4):
 *   1. **Ice-breakers**: 5h before `agreedTime`, send AI-generated
 *      conversation starters to both users.
 *   2. **Emergency window**: at the same 5h mark, notify both users
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
const ICEBREAKER_TOPICS_DE = [
  "Was war das spontanste, was du je gemacht hast?",
  "Mit wem würdest du gern essen gehen - egal aus welcher Zeit?",
  "Was möchtest du dieses Jahr lernen?",
];
const ICEBREAKER_TOPICS_PL = [
  "Jaka jest najbardziej spontaniczna rzecz, którą zrobiłeś/zrobiłaś?",
  "Z kim poszedłbyś/poszłabyś na kolację - z dowolnej epoki?",
  "Czego chcesz się nauczyć w tym roku?",
];

function icebreakerTopicsFallback(lang: Language): string[] {
  if (lang === "ru") return ICEBREAKER_TOPICS_RU;
  if (lang === "uk") return ICEBREAKER_TOPICS_UK;
  if (lang === "de") return ICEBREAKER_TOPICS_DE;
  if (lang === "pl") return ICEBREAKER_TOPICS_PL;
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
  matchProfilerBlock: string | null,
  lang: Language,
): Promise<string[]> {
  const systemPrompt = generateIceBreakersPrompt({
    userFirstName,
    matchFirstName,
    userSummary,
    matchSummary,
    matchProfilerBlock,
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

/**
 * §6 source-masked date-planning hints, derived from the PARTNER's Profiler
 * answers. Returns "" when there's nothing to say or the LLM is unavailable —
 * the icebreaker DM is sent either way, hints just get appended when present.
 */
async function generateDateHints(
  viewerFirstName: string,
  partnerProfilerBlock: string | null,
  lang: Language,
): Promise<string> {
  if (!partnerProfilerBlock) return "";
  const systemPrompt = generateDateHintsPrompt({
    viewerFirstName,
    partnerProfilerBlock,
    language: lang,
  });
  const text = await callOpenAIText(systemPrompt, "Write the 2-3 planning tips now.", {
    maxTokens: 200,
  });
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
  return lines.join("\n");
}

export interface DateLifecycleResult {
  icebreakers: number;
  emergencies: number;
  feedbacks: number;
  wingmen: number;
}

/**
 * Single lifecycle tick. Returns counts for logging / testing.
 */
export async function runDateLifecycleTick(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<DateLifecycleResult> {
  const result: DateLifecycleResult = {
    icebreakers: 0,
    emergencies: 0,
    feedbacks: 0,
    wingmen: 0,
  };

  // 0. Venue change expiry — auto-cancel any stalled `proposed` swap whose
  // deadline (TTL or the T-5h cutoff) has passed. Runs BEFORE the ice-breaker
  // step below so a pending venue change never lets ice-breakers fire on a
  // venue that's mid-change. Cheap no-op query when the feature is off
  // (no `proposed` rows ever exist).
  const venueChangesExpired = await sweepExpiredVenueChanges(api, now);
  if (venueChangesExpired > 0) {
    console.log(`[date-lifecycle] expired ${venueChangesExpired} stalled venue change(s)`);
  }

  // 1 & 2. Ice-breakers + Emergency window — 5h before agreed_time
  const alertThreshold = new Date(now.getTime() + DATE_ALERT_HOURS * 60 * 60 * 1000);

  const upcomingDates = await prisma.match.findMany({
    where: {
      status: "scheduled",
      // M-14: gate on `gt: now` so a row whose date already passed (because
      // a previous tick crashed before stamping `icebreakersSentAt`) doesn't
      // get a stale "your date is in 5h" message AFTER the date.
      agreedTime: { gt: now, lte: alertThreshold },
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
    // H2: claim the idempotency marker atomically BEFORE doing any awaited
    // side-effect. A row can only be claimed once (the `icebreakersSentAt:
    // null` guard collapses concurrent claimers to a single winner), so even
    // if two ticks overlap — or a future multi-process deploy runs the
    // lifecycle on more than one node — the ice-breaker / emergency DMs are
    // sent exactly once. The generated content (`iceBreakersA/B`) is persisted
    // in a follow-up update once it's ready. Ice-breaker generation always
    // produces output (graceful static fallback), so claiming up front never
    // strands a match the way it would for the retry-capable wingman loop.
    const claimed = await prisma.match.updateMany({
      where: { id: match.id, icebreakersSentAt: null },
      data: { icebreakersSentAt: now },
    });
    if (claimed.count === 0) continue;

    const langA = (match.userA.language ?? "en") as Language;
    const langB = (match.userB.language ?? "en") as Language;

    // Fetch profile summaries + Profiler answers for personalised content.
    // Profiler answers are the PRIMARY source (PRODUCT_SPEC §Phase 1b); the
    // psychological summary is the fallback the prompts use when they're empty.
    const [profileA, profileB, answersA, answersB] = await Promise.all([
      prisma.profile.findUnique({
        where: { userId: match.userA.id },
        select: { psychologicalSummary: true },
      }),
      prisma.profile.findUnique({
        where: { userId: match.userB.id },
        select: { psychologicalSummary: true },
      }),
      prisma.profilerAnswer.findMany({
        where: { userId: match.userA.id },
        select: { questionId: true, answerText: true },
      }),
      prisma.profilerAnswer.findMany({
        where: { userId: match.userB.id },
        select: { questionId: true, answerText: true },
      }),
    ]);

    const nameA = match.userA.firstName ?? "User";
    const nameB = match.userB.firstName ?? "User";
    const summaryA = profileA?.psychologicalSummary ?? null;
    const summaryB = profileB?.psychologicalSummary ?? null;

    const scoredA = scoreProfilerAnswers(answersA);
    const scoredB = scoreProfilerAnswers(answersB);
    // The block describing the PARTNER, rendered in the reader's language.
    const partnerBlockForA = formatProfilerAnswersBlock(scoredB, langA);
    const partnerBlockForB = formatProfilerAnswersBlock(scoredA, langB);

    // Generate ice-breakers + §6 hints via LLM (both fall back gracefully).
    const [topicsForA, topicsForB, hintsForA, hintsForB] = await Promise.all([
      generatePersonalisedIceBreakers(nameA, nameB, summaryA, summaryB, partnerBlockForA, langA),
      generatePersonalisedIceBreakers(nameB, nameA, summaryB, summaryA, partnerBlockForB, langB),
      generateDateHints(nameA, partnerBlockForA, langA),
      generateDateHints(nameB, partnerBlockForB, langB),
    ]);

    const topicsAFormatted = topicsForA.map((q, i) => `${i + 1}. ${q}`).join("\n");
    const topicsBFormatted = topicsForB.map((q, i) => `${i + 1}. ${q}`).join("\n");

    const msgA =
      t(langA, "icebreakerIntro") + topicsAFormatted +
      (hintsForA ? t(langA, "dateHintsIntro") + hintsForA : "");
    const msgB =
      t(langB, "icebreakerIntro") + topicsBFormatted +
      (hintsForB ? t(langB, "dateHintsIntro") + hintsForB : "");

    // Emergency cancellation button
    const emergKbA = new InlineKeyboard().text(t(langA, "emergencyBtn"), `emerg:start:${match.id}`);
    const emergKbB = new InlineKeyboard().text(t(langB, "emergencyBtn"), `emerg:start:${match.id}`);

    // Per-leg .catch + telegramId guard. Mobile-first synthetic users
    // (telegramId <= 0n) get the Expo push path elsewhere; sending to a
    // negative chat id throws "chat not found" and used to abort the entire
    // for-loop, leaving icebreakersSentAt null and causing duplicate sends
    // on the next 2-min tick.
    const sendIfTelegram = (
      tgId: bigint,
      text: string,
      opts?: Parameters<typeof api.sendMessage>[2],
    ): Promise<unknown> | null => {
      if (tgId <= 0n) return null;
      return api.sendMessage(Number(tgId), text, opts).catch((err: unknown) => {
        console.warn(
          `[date-lifecycle] icebreaker/emergency send failed for ${tgId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    };

    const sends: Array<Promise<unknown> | null> = [
      sendIfTelegram(match.userA.telegramId, msgA),
      sendIfTelegram(match.userB.telegramId, msgB),
      sendIfTelegram(match.userA.telegramId, t(langA, "emergencyUnlocked"), {
        reply_markup: emergKbA,
        parse_mode: "Markdown",
      }),
      sendIfTelegram(match.userB.telegramId, t(langB, "emergencyUnlocked"), {
        reply_markup: emergKbB,
        parse_mode: "Markdown",
      }),
    ];

    await Promise.all(sends.filter((p): p is Promise<unknown> => p !== null));

    // `icebreakersSentAt` was already stamped by the atomic claim above
    // (H2); persist only the generated content here. We'd rather miss one
    // send than duplicate-spam every 2 minutes (C-3 in the prior audit).
    await prisma.match.update({
      where: { id: match.id },
      data: {
        iceBreakersA: topicsForA,
        iceBreakersB: topicsForB,
      },
    });

    result.icebreakers++;
    result.emergencies++;
  }

  // 2b. Wingman hints — reveal window opens at T-1.5h.
  //
  // Generation already happened at `scheduled` transition; we may still
  // call `generateAndSaveWingmanHints` here to cover backfill (matches
  // that scheduled before this feature shipped, or where the earlier
  // generation silently fell back to a null row).
  const wingmanThreshold = new Date(
    now.getTime() + PRE_DATE_WINGMAN_HOURS * 60 * 60 * 1000,
  );

  const wingmanTargets = await prisma.match.findMany({
    where: {
      status: "scheduled",
      agreedTime: { lte: wingmanThreshold, gt: now },
      wingmanSentAt: null,
    },
    select: {
      id: true,
      wingmanHintA: true,
      wingmanHintB: true,
      userA: {
        select: { id: true, telegramId: true, language: true, platform: true },
      },
      userB: {
        select: { id: true, telegramId: true, language: true, platform: true },
      },
    },
  });

  for (const match of wingmanTargets) {
    // Backfill if either side is missing; idempotent inside the service.
    let hintA = match.wingmanHintA;
    let hintB = match.wingmanHintB;
    if (!hintA || !hintB) {
      const generated = await generateAndSaveWingmanHints(match.id);
      if (generated) {
        hintA = generated.a;
        hintB = generated.b;
      }
    }
    if (!hintA || !hintB) continue; // nothing to deliver yet; retry next tick

    const wingmanClaim = await prisma.match.updateMany({
      where: { id: match.id, status: "scheduled", wingmanSentAt: null },
      data: { wingmanSentAt: now },
    });
    if (wingmanClaim.count === 0) continue;

    const langA = (match.userA.language ?? "en") as Language;
    const langB = (match.userB.language ?? "en") as Language;

    const deliveries: Array<Promise<unknown>> = [];

    // Telegram DM — telegram + "both" platform users (telegramId > 0).
    if (
      (match.userA.platform === "telegram" || match.userA.platform === "both") &&
      match.userA.telegramId > 0n
    ) {
      deliveries.push(
        api
          .sendMessage(
            Number(match.userA.telegramId),
            `${t(langA, "wingmanHintIntro")}${hintA}`,
          )
          .catch((err) => console.warn("[wingman] telegram A failed:", err)),
      );
    }
    if (
      (match.userB.platform === "telegram" || match.userB.platform === "both") &&
      match.userB.telegramId > 0n
    ) {
      deliveries.push(
        api
          .sendMessage(
            Number(match.userB.telegramId),
            `${t(langB, "wingmanHintIntro")}${hintB}`,
          )
          .catch((err) => console.warn("[wingman] telegram B failed:", err)),
      );
    }

    // Expo push — mobile + "both" platform users.
    if (match.userA.platform === "mobile" || match.userA.platform === "both") {
      deliveries.push(
        sendPushToUser(match.userA.id, {
          title: "Secret Insight",
          body: hintA,
          data: { type: "match.wingman", matchId: match.id },
        }).catch((err) => console.warn("[wingman] push A failed:", err)),
      );
    }
    if (match.userB.platform === "mobile" || match.userB.platform === "both") {
      deliveries.push(
        sendPushToUser(match.userB.id, {
          title: "Secret Insight",
          body: hintB,
          data: { type: "match.wingman", matchId: match.id },
        }).catch((err) => console.warn("[wingman] push B failed:", err)),
      );
    }

    await Promise.all(deliveries);

    result.wingmen++;
  }

  // 3. Feedback prompt — 24h after agreed_time
  const feedbackThreshold = new Date(now.getTime() - FEEDBACK_DELAY_HOURS * 60 * 60 * 1000);

  // C-1: dedup on `feedbackPromptedAt`, NOT status flip + null feedback.
  // The previous query re-matched every tick whenever feedback was unanswered
  // (the common case), spamming both users every 2 minutes after the date.
  const pastDates = await prisma.match.findMany({
    where: {
      status: { in: ["scheduled", "completed"] },
      agreedTime: { lte: feedbackThreshold },
      feedbackPromptedAt: null,
    },
    select: {
      id: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });

  for (const match of pastDates) {
    const feedbackClaim = await prisma.match.updateMany({
      where: {
        id: match.id,
        status: { in: ["scheduled", "completed"] },
        feedbackPromptedAt: null,
      },
      data: { status: "completed", feedbackPromptedAt: now },
    });
    if (feedbackClaim.count === 0) continue;

    const langA = (match.userA.language ?? "en") as Language;
    const langB = (match.userB.language ?? "en") as Language;

    const kbA = buildFeedbackKeyboard(match.id, langA);
    const kbB = buildFeedbackKeyboard(match.id, langB);

    // Bot API 7.6 message_effect — a soft "your moment matters" flourish on
    // the prompt itself. Empty env falls through to no effect.
    const effectId = env.MESSAGE_EFFECT_FEEDBACK_ID || undefined;
    const optsA = {
      reply_markup: kbA,
      ...(effectId ? { message_effect_id: effectId } : {}),
    };
    const optsB = {
      reply_markup: kbB,
      ...(effectId ? { message_effect_id: effectId } : {}),
    };

    // Per-leg .catch + telegramId guard so a blocked / mobile-only user
    // doesn't abort the loop and re-fire the prompt every 2 minutes.
    const feedbackSends: Array<Promise<unknown> | null> = [
      match.userA.telegramId > 0n
        ? api
            .sendMessage(Number(match.userA.telegramId), t(langA, "feedbackInvitation"), optsA)
            .catch((err: unknown) =>
              console.warn(
                `[date-lifecycle] feedback send failed for ${match.userA.telegramId}:`,
                err instanceof Error ? err.message : err,
              ),
            )
        : null,
      match.userB.telegramId > 0n
        ? api
            .sendMessage(Number(match.userB.telegramId), t(langB, "feedbackInvitation"), optsB)
            .catch((err: unknown) =>
              console.warn(
                `[date-lifecycle] feedback send failed for ${match.userB.telegramId}:`,
                err instanceof Error ? err.message : err,
              ),
            )
        : null,
    ];

    await Promise.all(feedbackSends.filter((p): p is Promise<unknown> => p !== null));

    result.feedbacks++;
  }

  return result;
}
