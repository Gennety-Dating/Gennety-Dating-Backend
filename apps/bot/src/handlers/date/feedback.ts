import { prisma } from "@gennety/db";
import { t, parsePostDateFeedbackPrompt, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { callOpenAIJson } from "../../services/openai.js";
import { appendNegativeConstraint } from "../matching/negative-constraints.js";
import {
  claimMatchFlow,
  releaseMatchFlowClaim,
} from "../../services/match-flow-claim.js";

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
  | {
      ok: false;
      reason: "match-not-found" | "not-participant" | "wrong-state" | "empty-text" | "already-submitted";
    };

const MAX_FEEDBACK_LEN = 1000;

/**
 * How many times a submission re-reads the row after losing its compare-and-set.
 * One retry covers the only race that can end in a legitimate write: a story
 * landing a moment before the form that is allowed to follow it.
 */
const FEEDBACK_CLAIM_ATTEMPTS = 2;

export interface RecordFeedbackInput {
  userId: string;
  matchId: string;
  text: string;
  language: Language;
  /**
   * May this submission land on text already recorded on this side?
   *
   * Absent means never, which is right for the voice note and the menu agent's
   * story: they are accepted only onto an empty side. The structured form
   * (`submitPostDateFeedback`) passes a predicate instead, because a story told
   * in conversation must not close the form — the rating and the second-date
   * answer come only from there (decision 2026-09-08) — while a second form
   * answer must be refused.
   */
  mayFollow?: (existing: string) => boolean;
}

/**
 * Persist post-date feedback and run the LLM analysis pass. Shared between
 * the Mini App POST endpoint and the bot's voice/text fallback path so both
 * surfaces produce identical side-effects (`Match.feedbackByA/B` write + new
 * negative constraints appended to the actor's profile).
 *
 * Each source answers once per side. This used to overwrite: every repeat —
 * the Mini App link tapped twice, the menu agent recording the same story
 * again — replaced the blob AND re-ran the analysis, which appends negative
 * constraints rather than replacing them, so the same complaint landed on the
 * profile once per submission and weighed on matching that many times, each
 * one another paid OpenAI call. The write is therefore a compare-and-set on the
 * value this call read, and the analysis runs only for the call that won it —
 * a concurrent double-submit included — and only over its OWN text.
 *
 * When a permitted submission follows earlier text (the form after a story),
 * the earlier text is kept below the new one rather than overwritten: it is
 * already analysed, and it is still the person's own account of the evening.
 * The new text leads, so a structured answer stays recognisable by its header.
 */
export async function recordPostDateFeedback(
  input: RecordFeedbackInput,
): Promise<RecordFeedbackResult> {
  const trimmed = input.text.trim().slice(0, MAX_FEEDBACK_LEN);
  if (!trimmed) return { ok: false, reason: "empty-text" };

  let claimed = false;
  for (let attempt = 0; attempt < FEEDBACK_CLAIM_ATTEMPTS && !claimed; attempt++) {
    const match = await prisma.match.findUnique({
      where: { id: input.matchId },
      select: {
        id: true,
        status: true,
        userAId: true,
        userBId: true,
        feedbackByA: true,
        feedbackByB: true,
      },
    });
    if (!match) return { ok: false, reason: "match-not-found" };
    if (match.status !== "completed") return { ok: false, reason: "wrong-state" };

    const isA = input.userId === match.userAId;
    const isB = input.userId === match.userBId;
    if (!isA && !isB) return { ok: false, reason: "not-participant" };

    const existing = (isA ? match.feedbackByA : match.feedbackByB) ?? null;
    if (existing !== null && !(input.mayFollow?.(existing) ?? false)) {
      return { ok: false, reason: "already-submitted" };
    }
    const stored = existing === null ? trimmed : `${trimmed}\n\n${existing}`;

    const result = await prisma.match.updateMany({
      where: isA
        ? { id: input.matchId, feedbackByA: existing }
        : { id: input.matchId, feedbackByB: existing },
      data: isA ? { feedbackByA: stored } : { feedbackByB: stored },
    });
    claimed = result.count === 1;
  }
  if (!claimed) return { ok: false, reason: "already-submitted" };

  // LLM analysis — extract chemistry signals and new constraints.
  // Failures here are non-critical: the raw feedback is already saved above.
  try {
    const systemPrompt = parsePostDateFeedbackPrompt({ language: input.language });
    const analysis = await callOpenAIJson<ParsedPostDateFeedback>(systemPrompt, trimmed);
    if (analysis) {
      // One refresh for the whole batch, not one per constraint: each append
      // marks the profile dirty, and re-embedding after every line would buy
      // nothing but N OpenAI calls. The last append does it for all of them.
      const constraints = analysis.new_negative_constraints;
      for (const [i, constraint] of constraints.entries()) {
        await appendNegativeConstraint(input.userId, constraint, input.language, {
          refreshEmbedding: i === constraints.length - 1,
        });
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
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      feedbackByA: true,
      feedbackByB: true,
    },
  });
  if (!match || match.status !== "completed") return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  if (user.id !== match.userAId && user.id !== match.userBId) return;

  const lang = ctx.session.language;
  // Anything already on this side refuses a voice note — the form, an earlier
  // voice note, or a story told to the concierge — so say so before they record
  // a minute of audio the pipeline would not keep. A voice note is plain text
  // exactly like that story and nothing on the row tells the two apart, so it
  // cannot be let through after one without letting voice notes repeat. The
  // structured form in the same DM stays open to them after a story.
  const alreadyAnswered = user.id === match.userAId ? match.feedbackByA : match.feedbackByB;
  if (alreadyAnswered) {
    await ctx.reply(t(lang, "feedbackAlreadySubmitted"));
    return;
  }

  claimMatchFlow(ctx.session, "awaiting_feedback", matchId);

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

  releaseMatchFlowClaim(ctx.session);

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const lang = ctx.session.language;
  const recorded = await recordPostDateFeedback({
    userId: user.id,
    matchId,
    text,
    language: lang,
  });

  await ctx.reply(
    t(
      lang,
      !recorded.ok && recorded.reason === "already-submitted"
        ? "feedbackAlreadySubmitted"
        : "feedbackThanks",
    ),
  );
}
