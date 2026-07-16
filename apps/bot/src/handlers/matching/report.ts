import { prisma } from "@gennety/db";
import { t, parseReportTriagePrompt, type Language, type TranslationKey } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { callOpenAIJson } from "../../services/openai.js";
import {
  applyReportAction,
  notifyReportedUser,
  type ReportTier,
} from "../../services/moderation.js";

/**
 * Post-match Report flow (PRODUCT_SPEC extension — Reporting & Moderation).
 *
 * Callback format:
 *   - `report:open:{matchId}` → show structured categories
 *   - `rc:{matchId}:{category}` → optional details step
 *   - `rs:{matchId}` → submit category-only report
 *
 * The hybrid MVP keeps the whole flow in Telegram: users first choose a
 * category, then can optionally clarify with text or a voice note. Free-form
 * LLM triage still exists as an escalation tool, but the category acts as the
 * primary structured signal and a minimum severity floor.
 */

const MAX_REPORT_LEN = 1000;

type ReportCategory =
  | "fake_photos"
  | "wrong_person"
  | "offensive_behavior"
  | "unsafe_red_flag"
  | "spam_or_fraud"
  | "inappropriate_profile"
  | "other";

const REPORT_CATEGORY_CALLBACK_PREFIX = "rc:";
const REPORT_SKIP_CALLBACK_PREFIX = "rs:";
const LEGACY_REPORT_CATEGORY_CALLBACK_PREFIX = "report:category:";
const LEGACY_REPORT_SKIP_CALLBACK_PREFIX = "report:skip:";

const REPORT_CATEGORY_ORDER: readonly ReportCategory[] = [
  "fake_photos",
  "wrong_person",
  "offensive_behavior",
  "unsafe_red_flag",
  "spam_or_fraud",
  "inappropriate_profile",
  "other",
];

const REPORT_CATEGORY_LABEL_KEYS: Record<ReportCategory, TranslationKey> = {
  fake_photos: "reportCategoryFakePhotos",
  wrong_person: "reportCategoryWrongPerson",
  offensive_behavior: "reportCategoryOffensive",
  unsafe_red_flag: "reportCategoryUnsafe",
  spam_or_fraud: "reportCategorySpam",
  inappropriate_profile: "reportCategoryInappropriate",
  other: "reportCategoryOther",
};

const REPORT_CATEGORY_CANONICAL_LABELS: Record<ReportCategory, string> = {
  fake_photos: "Fake or misleading photos",
  wrong_person: "Wrong person in the photo",
  offensive_behavior: "Offensive or disturbing behavior",
  unsafe_red_flag: "Unsafe / red flag",
  spam_or_fraud: "Spam or fraud",
  inappropriate_profile: "Inappropriate profile",
  other: "Other",
};

const REPORT_CATEGORY_SUMMARIES: Record<Exclude<ReportCategory, "other">, string> = {
  fake_photos: "Misleading profile photos",
  wrong_person: "Identity mismatch in profile photos",
  offensive_behavior: "Reported offensive or disturbing behavior",
  unsafe_red_flag: "Reported safety concern",
  spam_or_fraud: "Reported spam or fraud concern",
  inappropriate_profile: "Reported inappropriate profile content",
};

const REPORT_CATEGORY_TIER_FLOOR: Record<ReportCategory, ReportTier | null> = {
  fake_photos: 2,
  wrong_person: 3,
  offensive_behavior: 2,
  unsafe_red_flag: 3,
  spam_or_fraud: 3,
  inappropriate_profile: 2,
  other: null,
};

interface ReportTriageResult {
  tier: number;
  reason_summary: string;
}

interface ResolvedReportTriage {
  tier: ReportTier;
  reason_summary: string;
  manualReviewRequired: boolean;
}

interface ReportContext {
  reporterId: string;
  reportedUserId: string;
  matchId: string;
}

export async function handleReportOpen(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("report:open:")) return;

  const matchId = data.slice("report:open:".length);
  if (!matchId) return;

  await ctx.answerCallbackQuery();

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, userAId: true, userBId: true },
  });
  if (!match) return;

  const isParticipant =
    user.id === match.userAId || user.id === match.userBId;
  if (!isParticipant) return;

  // Block duplicate reports early — the DB has a unique constraint as well.
  const existing = await prisma.report.findUnique({
    where: {
      reporterId_matchId: { reporterId: user.id, matchId: match.id },
    },
    select: { id: true },
  });
  const lang = ctx.session.language;
  if (existing) {
    await ctx.reply(t(lang, "reportDuplicate"));
    return;
  }

  ctx.session.matchFlow = "idle";
  ctx.session.activeMatchId = null;
  ctx.session.pendingReportCategory = null;

  await ctx.reply(t(lang, "reportAsk"), {
    reply_markup: buildReportCategoryKeyboard(matchId, lang),
  });
}

export async function handleReportCategory(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (
    !data?.startsWith(REPORT_CATEGORY_CALLBACK_PREFIX) &&
    !data?.startsWith(LEGACY_REPORT_CATEGORY_CALLBACK_PREFIX)
  ) {
    return;
  }

  const parsed = parseReportCategoryCallback(data);
  if (!parsed) return;
  const { matchId, category } = parsed;

  await ctx.answerCallbackQuery();

  const lang = ctx.session.language;
  const ctxData = await loadReportContext(ctx, matchId);
  if (ctxData === "duplicate") {
    await resetReportSession(ctx);
    await ctx.reply(t(lang, "reportDuplicate"));
    return;
  }
  if (!ctxData) {
    await resetReportSession(ctx);
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  ctx.session.matchFlow = "awaiting_report_details";
  ctx.session.activeMatchId = matchId;
  ctx.session.pendingReportCategory = category;

  const replyMarkup =
    category === "other"
      ? undefined
      : { reply_markup: buildReportSkipKeyboard(matchId, lang) };
  const askKey = category === "other" ? "reportDetailAskOther" : "reportDetailAsk";
  await ctx.reply(t(lang, askKey), replyMarkup);
}

export async function handleReportSkip(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (
    !data?.startsWith(REPORT_SKIP_CALLBACK_PREFIX) &&
    !data?.startsWith(LEGACY_REPORT_SKIP_CALLBACK_PREFIX)
  ) {
    return;
  }

  const matchId = parseReportSkipCallback(data);
  if (!matchId) return;

  await ctx.answerCallbackQuery();

  const lang = ctx.session.language;
  const category = ctx.session.pendingReportCategory as ReportCategory | null;
  const activeMatchId = ctx.session.activeMatchId;
  await resetReportSession(ctx);

  if (!category || category === "other" || activeMatchId !== matchId) {
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  await submitStructuredReport(ctx, {
    matchId,
    category,
    detailText: "",
  });
}

export async function handleReportText(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;
  if (ctx.session.matchFlow !== "awaiting_report_details") return;

  const matchId = ctx.session.activeMatchId;
  const category = ctx.session.pendingReportCategory as ReportCategory | null;
  await resetReportSession(ctx);

  const lang = ctx.session.language;
  if (!matchId || !category) {
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  await submitStructuredReport(ctx, {
    matchId,
    category,
    detailText: text,
  });
}

function buildReportCategoryKeyboard(
  matchId: string,
  lang: Language,
): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[][] = REPORT_CATEGORY_ORDER.map((category) => [
    {
      text: t(lang, REPORT_CATEGORY_LABEL_KEYS[category]),
      // Compact prefix keeps UUID + longest category under Telegram's
      // 64-byte callback_data limit.
      callback_data: `${REPORT_CATEGORY_CALLBACK_PREFIX}${matchId}:${category}`,
    },
  ]);

  return { inline_keyboard: buttons };
}

function buildReportSkipKeyboard(
  matchId: string,
  lang: Language,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: t(lang, "reportSkipBtn"),
          callback_data: `${REPORT_SKIP_CALLBACK_PREFIX}${matchId}`,
        },
      ],
    ],
  };
}

function parseReportCategoryCallback(
  data: string,
): { matchId: string; category: ReportCategory } | null {
  const compact = data.startsWith(REPORT_CATEGORY_CALLBACK_PREFIX)
    ? data.slice(REPORT_CATEGORY_CALLBACK_PREFIX.length)
    : null;
  const legacy = data.startsWith(LEGACY_REPORT_CATEGORY_CALLBACK_PREFIX)
    ? data.slice(LEGACY_REPORT_CATEGORY_CALLBACK_PREFIX.length)
    : null;

  const payload = compact ?? legacy;
  if (!payload) return null;

  const [matchId, rawCategory] = payload.split(":");
  const category = rawCategory as ReportCategory | undefined;
  if (!matchId || !category || !isReportCategory(category)) return null;
  return { matchId, category };
}

function parseReportSkipCallback(data: string): string | null {
  if (data.startsWith(REPORT_SKIP_CALLBACK_PREFIX)) {
    return data.slice(REPORT_SKIP_CALLBACK_PREFIX.length) || null;
  }
  if (data.startsWith(LEGACY_REPORT_SKIP_CALLBACK_PREFIX)) {
    return data.slice(LEGACY_REPORT_SKIP_CALLBACK_PREFIX.length) || null;
  }
  return null;
}

async function resetReportSession(ctx: BotContext): Promise<void> {
  ctx.session.matchFlow = "idle";
  ctx.session.activeMatchId = null;
  ctx.session.pendingReportCategory = null;
}

async function submitStructuredReport(
  ctx: BotContext,
  input: {
    matchId: string;
    category: ReportCategory;
    detailText: string;
  },
): Promise<void> {
  const lang = ctx.session.language;
  const reportContext = await loadReportContext(ctx, input.matchId);
  if (reportContext === "duplicate") {
    await ctx.reply(t(lang, "reportDuplicate"));
    return;
  }
  if (!reportContext) {
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  const detailText = input.detailText.trim().slice(0, MAX_REPORT_LEN);
  const rawText = composeRawReportText(input.category, detailText);
  const triage = await resolveStructuredTriage({
    category: input.category,
    detailText,
    language: lang,
  });
  const tier: ReportTier = triage.tier;
  const reasonSummary = triage.reason_summary;
  let outcome:
    | Awaited<ReturnType<typeof applyReportAction>>
    | { kind: "tier1" }
    | null = null;

  try {
    if (triage.manualReviewRequired) {
      await prisma.report.create({
        data: {
          reporterId: reportContext.reporterId,
          reportedId: reportContext.reportedUserId,
          matchId: reportContext.matchId,
          rawText,
          tier: 3,
          reasonSummary,
          adminReviewed: false,
        },
      });
    } else if (tier === 1) {
      await prisma.report.create({
        data: {
          reporterId: reportContext.reporterId,
          reportedId: reportContext.reportedUserId,
          matchId: reportContext.matchId,
          rawText,
          tier,
          reasonSummary,
          adminReviewed: true,
        },
      });
      await applyReportAction({
        tier,
        reporterUserId: reportContext.reporterId,
        reportedUserId: reportContext.reportedUserId,
        reasonSummary,
        language: lang,
      });
      outcome = { kind: "tier1" };
    } else {
      outcome = await prisma.$transaction(async (tx) => {
        await tx.report.create({
          data: {
            reporterId: reportContext.reporterId,
            reportedId: reportContext.reportedUserId,
            matchId: reportContext.matchId,
            rawText,
            tier,
            reasonSummary,
            adminReviewed: tier !== 3,
          },
        });
        return applyReportAction({
          tier,
          reporterUserId: reportContext.reporterId,
          reportedUserId: reportContext.reportedUserId,
          reasonSummary,
          language: lang,
        }, tx, ctx.api);
      });
    }
  } catch (err) {
    // Unique violation (reporter already filed on this match) or transient DB error.
    console.warn("Failed to persist report:", err);
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  if (!triage.manualReviewRequired && outcome) {
    await notifyReportedUser(ctx.api, reportContext.reportedUserId, outcome);
  }

  const thanksKey =
    triage.manualReviewRequired || tier === 3
      ? "reportThanksT3"
      : tier === 2
        ? "reportThanksT2"
        : "reportThanksT1";
  await ctx.reply(t(lang, thanksKey));
}

async function resolveStructuredTriage(input: {
  category: ReportCategory;
  detailText: string;
  language: Language;
}): Promise<ResolvedReportTriage> {
  const categoryFloor = REPORT_CATEGORY_TIER_FLOOR[input.category];
  const categorySummary = categoryFloor == null
    ? "Unclassified report"
    : REPORT_CATEGORY_SUMMARIES[input.category as Exclude<ReportCategory, "other">];

  if (!input.detailText) {
    if (categoryFloor != null) {
      return {
        tier: categoryFloor,
        reason_summary: categorySummary,
        manualReviewRequired: false,
      };
    }
    return {
      tier: 3,
      reason_summary: "Manual review required: missing report details",
      manualReviewRequired: true,
    };
  }

  const fallback: ResolvedReportTriage =
    categoryFloor != null
      ? {
          tier: categoryFloor,
          reason_summary: categorySummary,
          manualReviewRequired: false,
        }
      : {
          tier: 3,
          reason_summary: "Manual review required: triage unavailable",
          manualReviewRequired: true,
        };

  try {
    const systemPrompt = parseReportTriagePrompt({ language: input.language });
    const triageText =
      `Category: ${REPORT_CATEGORY_CANONICAL_LABELS[input.category]}\n` +
      `Details: ${input.detailText}`;
    const parsed = await callOpenAIJson<ReportTriageResult>(systemPrompt, triageText);
    if (!parsed) return fallback;

    const parsedTier = normalizeTier(parsed.tier);
    const wasPromoted = categoryFloor != null && parsedTier < categoryFloor;
    const tier = wasPromoted ? categoryFloor : parsedTier;
    const parsedSummary = (parsed.reason_summary ?? "").trim().slice(0, 240);
    const summary = wasPromoted
      ? categorySummary
      : parsedSummary || categorySummary || fallback.reason_summary;
    return { tier, reason_summary: summary, manualReviewRequired: false };
  } catch {
    return fallback;
  }
}

async function loadReportContext(
  ctx: BotContext,
  matchId: string,
): Promise<ReportContext | "duplicate" | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return null;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, userAId: true, userBId: true },
  });
  if (!match) return null;

  const isParticipant = user.id === match.userAId || user.id === match.userBId;
  if (!isParticipant) return null;

  const existing = await prisma.report.findUnique({
    where: {
      reporterId_matchId: { reporterId: user.id, matchId: match.id },
    },
    select: { id: true },
  });
  if (existing) return "duplicate";

  const reportedUserId = match.userAId === user.id ? match.userBId : match.userAId;
  if (reportedUserId === user.id) return null;

  return {
    reporterId: user.id,
    reportedUserId,
    matchId: match.id,
  };
}

function composeRawReportText(category: ReportCategory, detailText: string): string {
  const header = `Category: ${REPORT_CATEGORY_CANONICAL_LABELS[category]}`;
  if (!detailText) return header;
  return `${header}\nDetails: ${detailText}`;
}

function isReportCategory(category: string): category is ReportCategory {
  return REPORT_CATEGORY_ORDER.includes(category as ReportCategory);
}

function normalizeTier(tier: unknown): ReportTier {
  if (tier === 2 || tier === 3) return tier;
  return 1;
}
