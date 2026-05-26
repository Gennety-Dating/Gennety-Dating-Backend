import { prisma } from "@gennety/db";
import { t, parsePostDateFeedbackPrompt, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { callOpenAIJson } from "../../services/openai.js";
import { appendNegativeConstraint } from "../matching/negative-constraints.js";

/**
 * Post-date feedback flow (PRODUCT_SPEC.md §Phase 4.3).
 *
 * Two entry points share one persistence + analysis pipeline:
 *   1. Mini App form — POST `/v1/feedback/post-date` (see
 *      `public/routes/feedback.ts`). The API constructs `text` from
 *      structured inputs (chemistry slider, second-date trichotomy, free text)
 *      and calls `recordPostDateFeedback`.
 *   2. Voice note — `feedback:voice:{matchId}` callback puts the session into
 *      `awaiting_feedback`; the upstream `voiceHandler` transcribes the next
 *      voice (or accepts typed text), then `handleFeedbackVoiceText` runs the
 *      same pipeline.
 *
 * The legacy single 📝 callback + chat-typing UX has been retired —
 * `feedback:start:` is no longer wired in the router.
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

export type RecordFeedbackResult =
  | { ok: true }
  | { ok: false; reason: "match-not-found" | "not-participant" | "wrong-state" | "empty-text" };

const MAX_FEEDBACK_LEN = 1000;

/**
 * Persist post-date feedback and run the LLM analysis pass. Shared between
 * the Mini App POST endpoint and the bot's voice/text fallback path so both
 * surfaces produce identical side-effects (`Match.feedbackByA/B` write + new
 * negative constraints appended to the actor's profile).
 *
 * Idempotent on the column write: a second call from the same actor just
 * overwrites their previous string.
 */
export async function recordPostDateFeedback(input: {
  userId: string;
  matchId: string;
  text: string;
  language: Language;
}): Promise<RecordFeedbackResult> {
  const trimmed = input.text.trim().slice(0, MAX_FEEDBACK_LEN);
  if (!trimmed) return { ok: false, reason: "empty-text" };

  const match = await prisma.match.findUnique({
    where: { id: input.matchId },
    select: { id: true, status: true, userAId: true, userBId: true },
  });
  if (!match) return { ok: false, reason: "match-not-found" };
  if (match.status !== "completed") return { ok: false, reason: "wrong-state" };

  const isA = input.userId === match.userAId;
  const isB = input.userId === match.userBId;
  if (!isA && !isB) return { ok: false, reason: "not-participant" };

  await prisma.match.update({
    where: { id: input.matchId },
    data: isA ? { feedbackByA: trimmed } : { feedbackByB: trimmed },
  });

  // LLM analysis — extract chemistry signals and new constraints.
  // Failures here are non-critical: the raw feedback is already saved above.
  try {
    const systemPrompt = parsePostDateFeedbackPrompt({ language: input.language });
    const analysis = await callOpenAIJson<ParsedPostDateFeedback>(systemPrompt, trimmed);
    if (analysis) {
      for (const constraint of analysis.new_negative_constraints) {
        await appendNegativeConstraint(input.userId, constraint, input.language);
      }
    }
  } catch {
    // Swallow — partial analysis failure must not invalidate the user's submission.
  }

  return { ok: true };
}

/**
 * Step 1 of the voice path — user tapped `[🎤 Send voice]` in the post-date
 * DM. Set the session to `awaiting_feedback` so the next voice/text turn is
 * routed back into this flow, send the bot's "I'm listening" chat action,
 * and reply with the recording instructions.
 */
export async function handleFeedbackVoiceStart(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("feedback:voice:")) return;

  const matchId = data.slice("feedback:voice:".length);
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

  if (user.id !== match.userAId && user.id !== match.userBId) return;

  ctx.session.matchFlow = "awaiting_feedback";
  ctx.session.activeMatchId = matchId;

  const lang = ctx.session.language;
  // Best-effort `record_voice` so the client shows "bot is recording…" before
  // the instructions land — sets expectation that a voice note is coming.
  try {
    await ctx.replyWithChatAction("record_voice");
  } catch {
    // Chat action is best-effort — never fail the turn on it.
  }
  await ctx.reply(t(lang, "feedbackVoiceAsk"));
}

/**
 * Step 2 of the voice path — user sent voice (transcribed by the upstream
 * `voiceHandler` into `ctx.message.text`) or typed text. Records the
 * feedback via the shared pipeline.
 */
export async function handleFeedbackVoiceText(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const matchId = ctx.session.activeMatchId;
  if (!matchId) return;

  ctx.session.matchFlow = "idle";
  ctx.session.activeMatchId = null;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const lang = ctx.session.language;
  await recordPostDateFeedback({
    userId: user.id,
    matchId,
    text,
    language: lang,
  });

  await ctx.reply(t(lang, "feedbackThanks"));
}
