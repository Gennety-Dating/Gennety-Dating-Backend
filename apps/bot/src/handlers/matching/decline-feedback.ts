import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { t, type Language, type TranslationKey } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { recordRejectionFeedback } from "../../services/rejection-feedback.js";

type DeclineReasonCode = "type" | "vibe" | "interests" | "lifestyle" | "other";
const DECLINE_REASON_CALLBACK_PREFIX = "mdr:";
const LEGACY_DECLINE_REASON_CALLBACK_PREFIX = "match:decline_reason:";

const QUICK_REASON_KEYS: Record<DeclineReasonCode, TranslationKey> = {
  type: "matchDeclineReasonType",
  vibe: "matchDeclineReasonVibe",
  interests: "matchDeclineReasonInterests",
  lifestyle: "matchDeclineReasonLifestyle",
  other: "matchDeclineReasonOther",
};

const QUICK_REASON_TEXT: Record<Exclude<DeclineReasonCode, "other">, string> = {
  type: "Preset reason: not my type",
  vibe: "Preset reason: different vibe",
  interests: "Preset reason: interests did not match",
  lifestyle: "Preset reason: lifestyle mismatch",
};

function declineReasonButton(
  matchId: string,
  lang: Language,
  code: DeclineReasonCode,
): InlineKeyboardButton.CallbackButton {
  return {
    text: t(lang, QUICK_REASON_KEYS[code]),
    // Telegram caps callback_data at 64 bytes. Keep this short enough for
    // UUID match ids plus the longest reason code.
    callback_data: `${DECLINE_REASON_CALLBACK_PREFIX}${matchId}:${code}`,
  };
}

export function buildDeclineReasonKeyboard(
  matchId: string,
  lang: Language,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        declineReasonButton(matchId, lang, "type"),
        declineReasonButton(matchId, lang, "vibe"),
      ],
      [
        declineReasonButton(matchId, lang, "interests"),
        declineReasonButton(matchId, lang, "lifestyle"),
      ],
      [declineReasonButton(matchId, lang, "other")],
    ],
  };
}

export async function handleDeclineReasonCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (
    !data?.startsWith(DECLINE_REASON_CALLBACK_PREFIX) &&
    !data?.startsWith(LEGACY_DECLINE_REASON_CALLBACK_PREFIX)
  ) {
    return;
  }

  const parsed = parseDeclineReasonCallback(data);
  if (!parsed) return;
  const { matchId, code } = parsed;

  await ctx.answerCallbackQuery();

  const lang = ctx.session.language;
  if (code === "other") {
    await ctx.reply(t(lang, "matchDeclineOtherAsk"));
    return;
  }

  const result = await recordRejectionFeedback({
    telegramId: BigInt(ctx.from!.id),
    matchId,
    reason: QUICK_REASON_TEXT[code],
    requireConcreteReason: false,
    updateNegativeConstraints: false,
  });

  if (result.success) {
    const key =
      result.status === "already_recorded"
        ? "matchDeclineAlreadyNoted"
        : "matchDeclineFeedbackSaved";
    await ctx.reply(t(lang, key));
    return;
  }

  await ctx.reply(t(lang, "matchDeclineFeedbackFailed"));
}

function parseDeclineReasonCallback(
  data: string,
): { matchId: string; code: DeclineReasonCode } | null {
  const compact = data.startsWith(DECLINE_REASON_CALLBACK_PREFIX)
    ? data.slice(DECLINE_REASON_CALLBACK_PREFIX.length)
    : null;
  const legacy = data.startsWith(LEGACY_DECLINE_REASON_CALLBACK_PREFIX)
    ? data.slice(LEGACY_DECLINE_REASON_CALLBACK_PREFIX.length)
    : null;

  const payload = compact ?? legacy;
  if (!payload) return null;

  const [matchId, rawCode] = payload.split(":");
  const code = rawCode as DeclineReasonCode | undefined;
  if (!matchId || !code || !(code in QUICK_REASON_KEYS)) return null;
  return { matchId, code };
}
