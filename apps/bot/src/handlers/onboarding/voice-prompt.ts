import { Composer, InlineKeyboard, type Api } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language, type SessionData } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { voiceCheckSteps } from "../../services/analysis-status.js";
import { markOnboardingField } from "../../services/onboarding-collector.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { deleteVoicePrompt, ingestTelegramVoicePrompt } from "../../services/voice-prompt.js";
import {
  claimVoicePrompt,
  isAwaitingVoicePrompt,
  releaseVoicePrompt,
} from "../../services/voice-prompt-claim.js";
import {
  isVoicePromptPanelTap,
  replyPanelMarkupFor,
  replyPanelSync,
} from "../../services/reply-panel.js";
import type { MediaValidationReason } from "../../services/profile-media-validation/types.js";

/**
 * Legacy: the skip used to be an inline chip under the ask.
 *
 * Nothing sends it any more — the skip is the bottom panel — but a chat that
 * received the old ask before this shipped still carries a live-looking button,
 * and an unanswered callback query spins forever. Kept as an alias into the
 * same drop path; delete once no such message can plausibly remain.
 */
export const ONBOARDING_VOICE_PROMPT_SKIP_CALLBACK = "onboarding:voice:skip";

/** The confirmation card's only button: keep this recording and move on. */
export const ONBOARDING_VOICE_PROMPT_KEEP_CALLBACK = "onb:vp:keep";

/**
 * The onboarding voice-prompt step (VOICE_PROMPT_PRODUCT_SPEC.md §4.1).
 *
 * The step does NOT end at the recording (founder decision — DECISIONS.md): a
 * recording can be re-recorded by sending another, dropped through the bottom
 * panel, or kept with one tap. So the claim outlives the first accepted clip,
 * which is also what keeps `voiceHandler` from mining a re-record into the fact
 * collector.
 *
 * Everything that leaves the step goes through `exitVoiceStep`, because that is
 * the one place that can be sure the bottom panel comes down with it.
 */
export const voicePromptRouter = new Composer<BotContext>();

/** The step is now waiting: it owns incoming voice until answered or skipped. */
export function armVoicePromptStep(ctx: BotContext): void {
  claimVoicePrompt(ctx.session);
}

voicePromptRouter.callbackQuery(ONBOARDING_VOICE_PROMPT_KEEP_CALLBACK, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  // A stale tap on a card whose step is already resolved: the exit ran once and
  // must not run twice (it resumes the collector).
  if (!isAwaitingVoicePrompt(ctx.session)) return;

  await retireVoicePromptCard(ctx);
  await exitVoiceStep(ctx, BigInt(telegramId), "kept");
});

voicePromptRouter.callbackQuery(ONBOARDING_VOICE_PROMPT_SKIP_CALLBACK, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  if (!isAwaitingVoicePrompt(ctx.session)) return;

  // The legacy chip lives on the ask, not on a confirmation card, so retire the
  // message that was actually tapped rather than the tracked one.
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await dropVoicePrompt(ctx, BigInt(telegramId));
});

voicePromptRouter.on("message:text", async (ctx, next) => {
  if (!isAwaitingVoicePrompt(ctx.session) || !isVoicePromptPanelTap(ctx.message.text)) {
    await next();
    return;
  }
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) {
    await next();
    return;
  }

  // A reply-keyboard tap arrives as an ordinary message from the user, so
  // without this the label sits in the chat as a line they appear to have said
  // — the same reason the photo panel's own tap is deleted.
  const chatId = ctx.chat?.id;
  if (chatId !== undefined) {
    await ctx.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
  }
  await dropVoicePrompt(ctx, BigInt(telegramId));
});

voicePromptRouter.on("message:voice", async (ctx, next) => {
  if (!isAwaitingVoicePrompt(ctx.session)) {
    await next();
    return;
  }

  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const voice = ctx.message.voice;
  if (telegramId === undefined || chatId === undefined) return;

  const language = ctx.session.language;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  });
  if (!user) return;

  // The ingest is a Bot API download plus two provider calls, so it is held
  // under a status rather than silence — the same treatment the photo burst
  // and the profile-video check already get.
  const work = ingestTelegramVoicePrompt({
    api: ctx.api,
    userId: user.id,
    fileId: voice.file_id,
    durationSeconds: voice.duration,
    ...(voice.file_size === undefined ? {} : { fileSizeBytes: voice.file_size }),
    ...(voice.mime_type === undefined ? {} : { mimeType: voice.mime_type }),
    language,
  });

  await runStatusSequence(ctx.api, chatId, voiceCheckSteps(language), {
    rich: true,
    until: work,
  });

  let result: Awaited<typeof work>;
  try {
    result = await work;
  } catch (err) {
    console.error("[voice-prompt] ingest threw:", err);
    // Spread the sync into every plain reply on this step: the panel is the
    // only way out of it, so a session that somehow lost it heals here rather
    // than stranding the user in front of a question with no exit.
    await ctx.reply(t(language, "voicePromptUnavailable"), replyPanelSync(ctx.session));
    return;
  }

  if (result.kind === "rejected") {
    // The step stays open and the claim stays live: every rejection here is
    // "record another one", and the panel is still at the bottom of the chat.
    await ctx.reply(rejectionText(language, result.reason), replyPanelSync(ctx.session));
    return;
  }

  // Accepted, and deliberately NOT the end of the step: no release, no field
  // write, no resume. A re-record overwrites the row, so the previous card's
  // button is retired first — otherwise two cards offer to keep two different
  // recordings and only one of them exists.
  await retireVoicePromptCard(ctx);
  const sent = await ctx.reply(
    t(language, "voicePromptRecorded", { button: t(language, "voicePromptSkipButton") }),
    {
      reply_markup: new InlineKeyboard().text(
        t(language, "voicePromptReviewDone"),
        ONBOARDING_VOICE_PROMPT_KEEP_CALLBACK,
      ),
    },
  );
  ctx.session.voicePromptCardMsgId = sent.message_id;
});

/**
 * Leave the step: no voice note.
 *
 * The panel means "no voice note", not "no MORE voice notes", so a recording
 * saved earlier in this same step is deleted rather than kept. The tracked card
 * id is what tells the two apart — before any recording there is nothing to
 * delete and the lookup is skipped entirely.
 */
async function dropVoicePrompt(ctx: BotContext, telegramId: bigint): Promise<void> {
  const hadRecording = ctx.session.voicePromptCardMsgId !== null;
  await retireVoicePromptCard(ctx);

  if (hadRecording) {
    try {
      const user = await prisma.user.findUnique({
        where: { telegramId },
        select: { id: true },
      });
      if (user) await deleteVoicePrompt(user.id);
    } catch (err) {
      // A recording that outlives its own deletion is a ghost the user cannot
      // see or clear, so it is logged loudly — but it must not trap them on the
      // step they just asked to leave.
      console.error("[voice-prompt] dropping the saved recording failed:", err);
    }
  }

  await exitVoiceStep(ctx, telegramId, "skipped");
}

/**
 * The single exit, and the only place the step's closing line is sent.
 *
 * Ordering is load-bearing: release first so `replyPanelSync` sees a step that
 * is over and answers with `remove_keyboard`; mark after the line so a failed
 * write leaves the user looking at a chat that has visibly moved on rather than
 * at a live panel; resume last so its insurance branch may legitimately re-arm
 * the step and raise the panel again.
 *
 * It owns the send rather than trusting each caller to spread the sync, because
 * this feature has already been burned by exactly that convention: the ask has
 * nine senders and eight of them were wrong (`services/voice-prompt-pending.ts`).
 */
async function exitVoiceStep(
  ctx: BotContext,
  telegramId: bigint,
  outcome: "kept" | "skipped",
): Promise<void> {
  releaseVoicePrompt(ctx.session);
  ctx.session.voicePromptCardMsgId = null;

  const line = t(ctx.session.language, outcome === "kept" ? "voicePromptSaved" : "voicePromptSkipped");
  await ctx.reply(line, replyPanelSync(ctx.session));

  await markOnboardingField(telegramId, "voice_prompt", outcome === "skipped");
  await resumeAfterVoiceStep(ctx, telegramId);
}

/** Strip the tracked confirmation card's button, best-effort. */
async function retireVoicePromptCard(ctx: BotContext): Promise<void> {
  const messageId = ctx.session.voicePromptCardMsgId;
  const chatId = ctx.chat?.id;
  ctx.session.voicePromptCardMsgId = null;
  if (messageId === null || chatId === undefined) return;

  await ctx.api
    .editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } })
    .catch(() => {
      // Telegram only lets a bot edit its own message for 48h; past that the
      // dead button is unavoidable, and it is still gated on the live claim.
    });
}

/**
 * Hand the conversation back to the collector so it finalizes.
 *
 * `markOnboardingField` advances `currentQuestion` to `complete`; the resume
 * turn is what makes the agent run `finalize_onboarding` and emit the closing
 * copy plus the verification CTA. Deliberately the same path the photo stage's
 * Continue takes rather than calling finalize directly — PRODUCT_SPEC §1.3
 * records what calling it directly cost: a session that believed the stage was
 * open while a question was still outstanding turned one tap into a refused
 * finalize with no way back to the missing question.
 */
async function resumeAfterVoiceStep(ctx: BotContext, telegramId: bigint): Promise<void> {
  const result = await runAgentTurn(telegramId, { kind: "resume" });

  if (result.onboardingComplete) {
    ctx.session.onboardingStep = "completed";
    ctx.session.menuState = "idle";
    ctx.session.expectingPhoto = false;
    releaseVoicePrompt(ctx.session);
  }
  // Normally `complete` by now, so this is insurance rather than a live
  // branch: if the field write lost its race the collector still says
  // voice_prompt, and re-asking without the panel would strand the user on a
  // question with no exit.
  if (
    ctx.chat?.id === undefined ||
    !(await sendVoicePromptAskIfRequested(ctx.api, ctx.chat.id, ctx.session, result))
  ) {
    if (result.reply) await ctx.reply(result.reply);
  }
  if (result.onboardingComplete) {
    // Lazily imported: `conversational.ts` imports this module to send the ask,
    // so an eager import here would make the two circular.
    const { finishOnboarding } = await import("./conversational.js");
    await finishOnboarding(ctx, telegramId, result.verificationRequired);
  }
}

function rejectionText(language: Language, reason: MediaValidationReason): string {
  switch (reason) {
    case "voice_too_short":
      return t(language, "voicePromptTooShort");
    case "voice_too_long":
      return t(language, "voicePromptTooLong");
    case "unsafe_content":
      return t(language, "voicePromptUnsafe");
    case "audio_contact_info":
      return t(language, "voicePromptContactInfo");
    default:
      return t(language, "voicePromptUnavailable");
  }
}

/**
 * The ask text plus the Telegram-only line naming the skip button.
 *
 * The question text itself is surface-neutral on purpose: `runAgentTurn`
 * returns the same string to the native rail over `/v1/onboarding/interview`,
 * where this panel does not exist and the client draws its own skip. So the
 * shared copy says the step CAN be skipped and this layer says WHERE — the same
 * split `conversational.ts` already states for the radar gate ("the agent names
 * the state, this surface renders the affordance").
 *
 * The label is interpolated rather than written out, so the sentence cannot
 * name a button the panel stopped using.
 */
export function voicePromptAskText(language: Language, question: string): string {
  return `${question}\n\n${t(language, "voicePromptSkipHint", {
    button: t(language, "voicePromptSkipButton"),
  })}`;
}

/**
 * The whole ask as one payload: the text, and the bottom panel that REPLACES
 * the photo stage's own (see `services/reply-panel.ts` — a message carries one
 * `reply_markup`, so the handover has to ride this message or not happen).
 *
 * Session-free so `type-radar.ts` can send the identical thing without holding
 * a live session; duplicating the send there is precisely the drift
 * `voice-prompt-senders.test.ts` exists to catch.
 */
export function voicePromptAskPayload(
  language: Language,
  question: string,
): { text: string; options: ReturnType<typeof replyPanelMarkupFor> } {
  return {
    text: voicePromptAskText(language, question),
    options: replyPanelMarkupFor("voice", language),
  };
}

/**
 * Deliver an agent turn that turned out to BE the voice-prompt ask.
 *
 * Returns true when it sent the ask — the caller then skips its own reply.
 *
 * This exists because `result.reply` is delivered to Telegram from nine call
 * sites and exactly one of them used to know about this step, so eight of them
 * sent the question as a bare message: no skip button, and — the damaging half
 * — no claim, which lets `voiceHandler` transcribe the recording into the fact
 * collector (`services/voice-prompt-pending.ts` has the full account). The
 * fix is not "remember to handle it": it is that every sender routes the reply
 * through one function, so a tenth sender inherits both halves.
 *
 * `voice-prompt-senders.test.ts` fails if a new site delivers `result.reply`
 * without passing it here first.
 */
export async function sendVoicePromptAskIfRequested(
  api: Api,
  chatId: number,
  session: SessionData,
  result: { reply: string; voicePromptRequested?: boolean },
): Promise<boolean> {
  if (result.voicePromptRequested !== true) return false;
  // Arm before sending: the claim is what makes `replyPanelSync` hand the
  // bottom panel from photos to voice, so the order is what puts the right
  // keyboard on this message. It also means a caller that persists the session
  // right after this returns saves the claim.
  claimVoicePrompt(session);
  await sendVoicePromptAsk(api, chatId, session, result.reply);
  return true;
}

/** Send the ask and hand it the bottom panel. Exported for the conversational handler. */
export async function sendVoicePromptAsk(
  api: Api,
  chatId: number,
  session: SessionData,
  text: string,
): Promise<void> {
  await api.sendMessage(chatId, voicePromptAskText(session.language, text), {
    ...replyPanelSync(session),
  });
}
