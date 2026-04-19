import { prisma } from "@gennety/db";
import { t, parsePostDateFeedbackPrompt } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { callOpenAIJson } from "../../services/openai.js";
import { appendNegativeConstraint } from "../matching/negative-constraints.js";

/**
 * Post-date feedback flow (PRODUCT_SPEC.md §Phase 4.3).
 *
 * The date-lifecycle cron sends a feedback prompt with a `feedback:start:{matchId}`
 * callback button 24h after the date. The handler here captures the free-text
 * feedback, parses it with the LLM to extract chemistry signals and new
 * matching constraints, and stores both the raw text and analysis.
 */

export interface ParsedPostDateFeedback {
  chemistry: boolean;
  chemistry_signals: string[];
  outcome: string;
  wants_second_date: boolean | null;
  new_positive_preferences: string[];
  new_negative_constraints: string[];
  feedback_summary: string;
  matching_adjustment: string;
  reasoning: string;
}

/** Step 1: User taps the feedback button → set session state. */
export async function handleFeedbackStart(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("feedback:start:")) return;

  const matchId = data.slice("feedback:start:".length);
  if (!matchId) return;

  await ctx.answerCallbackQuery();

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, status: true, userAId: true, userBId: true },
  });
  if (!match || match.status !== "completed") return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const isParticipant = user.id === match.userAId || user.id === match.userBId;
  if (!isParticipant) return;

  ctx.session.matchFlow = "awaiting_feedback";
  ctx.session.activeMatchId = matchId;

  const lang = ctx.session.language;
  await ctx.reply(t(lang, "feedbackAsk"));
}

/** Step 2: User sends free-text feedback. */
export async function handleFeedbackText(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const matchId = ctx.session.activeMatchId;
  if (!matchId) return;

  // Reset session state.
  ctx.session.matchFlow = "idle";
  ctx.session.activeMatchId = null;

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

  const isA = user.id === match.userAId;
  const isB = user.id === match.userBId;
  if (!isA && !isB) return;

  const trimmedFeedback = text.slice(0, 1000);
  const lang = ctx.session.language;

  // Store raw feedback
  await prisma.match.update({
    where: { id: matchId },
    data: isA ? { feedbackByA: trimmedFeedback } : { feedbackByB: trimmedFeedback },
  });

  // LLM analysis — extract chemistry signals and new constraints
  try {
    const systemPrompt = parsePostDateFeedbackPrompt({ language: lang });
    const analysis = await callOpenAIJson<ParsedPostDateFeedback>(
      systemPrompt,
      trimmedFeedback,
    );

    if (analysis) {
      // Persist new negative constraints from the date experience
      for (const constraint of analysis.new_negative_constraints) {
        await appendNegativeConstraint(user.id, constraint, lang);
      }
    }
  } catch {
    // Non-critical: raw feedback is already saved above
  }

  await ctx.reply(t(lang, "feedbackThanks"));
}
