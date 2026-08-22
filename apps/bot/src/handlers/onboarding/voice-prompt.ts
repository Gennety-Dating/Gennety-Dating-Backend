import { Composer, InlineKeyboard, type Api } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { voiceCheckSteps } from "../../services/analysis-status.js";
import { markOnboardingField } from "../../services/onboarding-collector.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { ingestTelegramVoicePrompt } from "../../services/voice-prompt.js";
import {
  claimVoicePrompt,
  isAwaitingVoicePrompt,
  releaseVoicePrompt,
} from "../../services/voice-prompt-claim.js";
import type { MediaValidationReason } from "../../services/profile-media-validation/types.js";

export const ONBOARDING_VOICE_PROMPT_SKIP_CALLBACK = "onboarding:voice:skip";

/**
 * The onboarding voice-prompt step (VOICE_PROMPT_PRODUCT_SPEC.md §4.1).
 *
 * One message, one quiet button, and no accept button: RECORDING is the
 * acceptance. An explicit "yes" would cost a tap and still leave the recording
 * to ask for.
 */
export const voicePromptRouter = new Composer<BotContext>();

/** The skip button, styled as every other secondary action in this product. */
export function voicePromptKeyboard(language: Language): InlineKeyboard {
  return new InlineKeyboard().text(
    t(language, "voicePromptSkipButton"),
    ONBOARDING_VOICE_PROMPT_SKIP_CALLBACK,
  );
}

/** The step is now waiting: it owns incoming voice until answered or skipped. */
export function armVoicePromptStep(ctx: BotContext): void {
  claimVoicePrompt(ctx.session);
}

voicePromptRouter.callbackQuery(ONBOARDING_VOICE_PROMPT_SKIP_CALLBACK, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  // Retire the button first: the step is over either way, and a live-looking
  // skip on a resolved question is the orphaned-button bug §2.1 already names.
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  releaseVoicePrompt(ctx.session);

  await markOnboardingField(BigInt(telegramId), "voice_prompt", true);
  await resumeAfterVoiceStep(ctx, BigInt(telegramId));
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
    await ctx.reply(t(language, "voicePromptUnavailable"));
    return;
  }

  if (result.kind === "rejected") {
    // The step stays open and the claim stays live: every rejection here is
    // "record another one", and the skip button is still on the ask above.
    await ctx.reply(rejectionText(language, result.reason));
    return;
  }

  releaseVoicePrompt(ctx.session);
  await ctx.reply(t(language, "voicePromptSaved"));
  await markOnboardingField(BigInt(telegramId), "voice_prompt");
  await resumeAfterVoiceStep(ctx, BigInt(telegramId));
});

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
  if (result.reply) await ctx.reply(result.reply);
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
 * where this keyboard does not exist and the client draws its own skip. So the
 * shared copy says the step CAN be skipped and this layer says WHERE — the same
 * split `conversational.ts` already states for the radar gate ("the agent names
 * the state, this surface renders the affordance").
 *
 * The label is interpolated rather than written out, so the sentence cannot
 * name a button the keyboard stopped using.
 */
export function voicePromptAskText(language: Language, question: string): string {
  return `${question}\n\n${t(language, "voicePromptSkipHint", {
    button: t(language, "voicePromptSkipButton"),
  })}`;
}

/** Send the ask and arm the step. Exported for the conversational handler. */
export async function sendVoicePromptAsk(
  api: Api,
  chatId: number,
  language: Language,
  text: string,
): Promise<void> {
  await api.sendMessage(chatId, voicePromptAskText(language, text), {
    reply_markup: voicePromptKeyboard(language),
  });
}
