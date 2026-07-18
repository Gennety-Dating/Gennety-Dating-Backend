/**
 * Conversational decision replies. The pitch closes with a natural question
 * ("So — want to go on a date with him?"), and the user may answer in plain
 * words instead of tapping the keyboard. This module classifies that reply
 * and turns it into the SAME mechanical confirmation the buttons provide:
 *
 *   - "yes"-intent  → a confirm card whose button is the existing
 *     `match:accept:{id}` commit (text alone never commits — the user always
 *     confirms with a tap, so an off-hand "да" can't lock an irreversible
 *     decision);
 *   - "no"-intent   → the existing decline confirmation card
 *     (`match:do:decline:{id}` / `match:keep:{id}`) — same guard as the
 *     keyboard path;
 *   - "unsure"      → a gentle "no rush" nudge, no state change;
 *   - anything else → not consumed; falls through to the menu agent.
 *
 * The blind-decision invariant is untouched: every reply is static copy that
 * reveals nothing about the partner's choice, and the actual commits reuse
 * the guarded callback handlers in decision.ts.
 *
 * Classification is keyword-first (fast, free, language-aware for all five
 * locales) with a small LLM fallback for longer/ambiguous messages; when the
 * LLM is unavailable the message simply falls through to the menu agent.
 */
import { prisma } from "@gennety/db";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { classifyDecisionIntent } from "../../services/decision-intent.js";
import { buildDeclineConfirmKeyboard } from "./decision.js";

function buildGoConfirmKeyboard(matchId: string, lang: Language): InlineKeyboardMarkup {
  const goBtn: InlineKeyboardButton.CallbackButton & Record<string, unknown> = {
    text: t(lang, "matchBtnConfirmGo"),
    // Reuses the pitch keyboard's accept commit — no new decision path.
    callback_data: `match:accept:${matchId}`,
    style: "success",
    ...(env.CUSTOM_EMOJI_ACCEPT_ID ? { icon_custom_emoji_id: env.CUSTOM_EMOJI_ACCEPT_ID } : {}),
  };
  const backBtn: InlineKeyboardButton.CallbackButton = {
    text: t(lang, "matchBtnKeepDeciding"),
    callback_data: `match:keep:${matchId}`,
  };
  return { inline_keyboard: [[goBtn as InlineKeyboardButton], [backBtn]] };
}

/**
 * Try to consume a plain-text message as an answer to a live match proposal.
 * Returns `true` when handled; `false` lets the message flow on (menu agent).
 */
export async function handleProposalTextReply(ctx: BotContext): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  const fromId = ctx.from?.id;
  if (!text || !fromId || text.startsWith("/")) return false;
  // Never hijack an active sub-flow (emergency reason, feedback, proxy chat,
  // report body, menu edits) — those own the user's raw text.
  if ((ctx.session.matchFlow ?? "idle") !== "idle") return false;
  if ((ctx.session.menuState ?? "idle") !== "idle") return false;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(fromId) },
    select: { id: true },
  });
  if (!user) return false;

  // The newest live proposal where THIS side hasn't decided and the pitch has
  // actually landed (pitchMessageId set for the side).
  const match = await prisma.match.findFirst({
    where: {
      status: "proposed",
      OR: [
        { userAId: user.id, acceptedByA: null, pitchMessageIdA: { not: null } },
        { userBId: user.id, acceptedByB: null, pitchMessageIdB: { not: null } },
      ],
    },
    orderBy: { dispatchedAt: "desc" },
    select: { id: true },
  });
  if (!match) return false;

  const intent = await classifyDecisionIntent(text);

  const lang = ctx.session.language;
  // The confirm card replies to the user's own words — the button visually
  // "flows out" of their answer instead of appearing as a detached message.
  const replyTo = ctx.message?.message_id
    ? {
        reply_parameters: {
          message_id: ctx.message.message_id,
          allow_sending_without_reply: true,
        },
      }
    : {};
  switch (intent) {
    case "yes":
      await ctx.reply(t(lang, "matchTextYesConfirm"), {
        reply_markup: buildGoConfirmKeyboard(match.id, lang),
        ...replyTo,
      });
      return true;
    case "no":
      // Same guarded confirmation card as the classic decline path.
      await ctx.reply(t(lang, "matchDeclineConfirmPrompt"), {
        parse_mode: "Markdown",
        reply_markup: buildDeclineConfirmKeyboard(match.id, lang),
        ...replyTo,
      });
      return true;
    case "unsure":
      await ctx.reply(t(lang, "matchTextUnsure"));
      return true;
    default:
      return false;
  }
}
