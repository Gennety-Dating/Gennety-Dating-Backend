import { prisma } from "@gennety/db";
import { t, parseReportTriagePrompt, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { callOpenAIJson } from "../../services/openai.js";
import {
  applyReportAction,
  notifyReportedUser,
  type ReportTier,
} from "../../services/moderation.js";

/**
 * Post-match Report flow (PRODUCT_SPEC extension — Reporting & Moderation).
 *
 * Callback format: `report:open:{matchId}`. User clicks → FSM moves to
 * `awaiting_report_details`; their next text message is triaged by the LLM
 * into a Tier (1/2/3) and handed to the moderation engine.
 */

const MAX_REPORT_LEN = 1000;

interface ReportTriageResult {
  tier: number;
  reason_summary: string;
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

  ctx.session.matchFlow = "awaiting_report_details";
  ctx.session.activeMatchId = matchId;

  await ctx.reply(t(lang, "reportAsk"));
}

export async function handleReportText(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;
  if (ctx.session.matchFlow !== "awaiting_report_details") return;

  const matchId = ctx.session.activeMatchId;
  ctx.session.matchFlow = "idle";
  ctx.session.activeMatchId = null;

  const lang = ctx.session.language;
  if (!matchId) {
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  const reporter = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!reporter) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, userAId: true, userBId: true },
  });
  if (!match) {
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  const reportedUserId =
    match.userAId === reporter.id ? match.userBId : match.userAId;
  if (reportedUserId === reporter.id) {
    // Reporter wasn't on this match.
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  const rawText = text.slice(0, MAX_REPORT_LEN);

  // Run the triage. Conservative fallback: if the LLM is unavailable,
  // treat as Tier 1 so we never auto-penalize without analysis. A human
  // can re-triage from the admin queue if needed.
  const triage = await runTriage(rawText, lang);
  const tier: ReportTier = triage.tier;
  const reasonSummary = triage.reason_summary;

  try {
    await prisma.report.create({
      data: {
        reporterId: reporter.id,
        reportedId: reportedUserId,
        matchId,
        rawText,
        tier,
        reasonSummary,
        // Tier 3 rows always need human review; Tier 1/2 are fully automated.
        adminReviewed: tier !== 3,
      },
    });
  } catch (err) {
    // Unique violation (reporter already filed on this match) or transient DB error.
    console.warn("Failed to persist report:", err);
    await ctx.reply(t(lang, "reportFailed"));
    return;
  }

  const outcome = await applyReportAction({
    tier,
    reporterUserId: reporter.id,
    reportedUserId,
    reasonSummary,
    language: lang,
  });

  await notifyReportedUser(ctx.api, reportedUserId, outcome);

  const thanksKey =
    tier === 1 ? "reportThanksT1" : tier === 2 ? "reportThanksT2" : "reportThanksT3";
  await ctx.reply(t(lang, thanksKey));
}

async function runTriage(
  rawText: string,
  language: Language,
): Promise<{ tier: ReportTier; reason_summary: string }> {
  const fallback = { tier: 1 as ReportTier, reason_summary: "Unclassifiable report" };

  try {
    const systemPrompt = parseReportTriagePrompt({ language });
    const parsed = await callOpenAIJson<ReportTriageResult>(systemPrompt, rawText);
    if (!parsed) return fallback;

    const tier = normalizeTier(parsed.tier);
    const summary = (parsed.reason_summary ?? "").trim().slice(0, 240)
      || fallback.reason_summary;
    return { tier, reason_summary: summary };
  } catch {
    return fallback;
  }
}

function normalizeTier(tier: unknown): ReportTier {
  if (tier === 2 || tier === 3) return tier;
  return 1;
}
