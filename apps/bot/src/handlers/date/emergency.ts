import { prisma } from "@gennety/db";
import { InlineKeyboard } from "grammy";
import { t, type Language } from "@gennety/shared";
import type { MessageEntity } from "grammy/types";
import type { BotContext } from "../../session.js";
import { applyEmergencyCancellationPeerBoost } from "../../utils/elo-calculator.js";
import { withRedactedSummary } from "../../services/outbound-recorder.js";
import {
  refundMatchTickets,
  ticketRefundNoticeKey,
} from "../../services/ticket-refund.js";

/**
 * Emergency cancellation flow (PRODUCT_SPEC.md §Phase 4.2).
 *
 * Callback `emerg:start:{matchId}` — user taps the "Cancel date" button
 * that was sent by the date-lifecycle cron 5h before the date. Because the
 * cancellation is irreversible (the match can never be restored), the bot
 * first asks for an explicit confirmation with the lower-risk path first:
 *   - `emerg:abort:{matchId}`   → dismiss, the date stays on
 *   - `emerg:confirm:{matchId}` → proceed to ask for the reason
 *
 * Once confirmed, the handler sets session state to `awaiting_emergency_reason`
 * and waits for a free-text message, which is then quoted *exactly as-is* to
 * the other person with a short Gennety note below it.
 */

/**
 * Shared guard: load a still-cancellable scheduled match for the tapping user.
 * Returns the participant user id, or null when the action should be ignored.
 */
async function loadCancellableParticipant(
  ctx: BotContext,
  matchId: string,
): Promise<string | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      emergencyCancelledBy: true,
    },
  });

  // Only allow for scheduled matches that haven't been cancelled yet.
  if (!match || match.status !== "scheduled" || match.emergencyCancelledBy) return null;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return null;

  const isParticipant = user.id === match.userAId || user.id === match.userBId;
  if (!isParticipant) return null;

  return user.id;
}

interface EmergencyCancellationNotice {
  text: string;
  entities: MessageEntity[];
}

export function buildEmergencyCancellationNotice(
  lang: Language,
  reason: string,
): EmergencyCancellationNotice {
  const prefix = `${t(lang, "emergencyReceivedOtherIntro")}\n\n`;
  const suffix = `\n\n${t(lang, "emergencyReceivedOtherSoftNote")}`;
  const text = `${prefix}${reason}${suffix}`;
  const entities: MessageEntity[] =
    reason.length > 0
      ? [{ type: "blockquote", offset: prefix.length, length: reason.length }]
      : [];
  return { text, entities };
}

/**
 * Step 1: User taps the emergency button → ask for an explicit confirmation
 * before doing anything irreversible. No session state is touched here, so a
 * stray tap is a pure no-op until the user confirms.
 */
export async function handleEmergencyStart(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("emerg:start:")) return;

  const matchId = data.slice("emerg:start:".length);
  if (!matchId) return;

  await ctx.answerCallbackQuery();

  const participantId = await loadCancellableParticipant(ctx, matchId);
  if (!participantId) return;

  const lang = ctx.session.language;
  const keyboard = new InlineKeyboard()
    .text(t(lang, "emergencyBtnBack"), `emerg:abort:${matchId}`)
    .success()
    .row()
    .text(t(lang, "emergencyBtnConfirm"), `emerg:confirm:${matchId}`)
    .danger();

  await ctx.reply(t(lang, "emergencyConfirmPrompt"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/** Step 1b: User confirmed the cancellation → ask for reason. */
export async function handleEmergencyConfirm(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("emerg:confirm:")) return;

  const matchId = data.slice("emerg:confirm:".length);
  if (!matchId) return;

  await ctx.answerCallbackQuery();

  const participantId = await loadCancellableParticipant(ctx, matchId);
  if (!participantId) return;

  ctx.session.matchFlow = "awaiting_emergency_reason";
  ctx.session.activeMatchId = matchId;

  const lang = ctx.session.language;
  // Drop the confirm/back buttons so the prompt can't be tapped twice.
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply(t(lang, "emergencyAskReason"), { parse_mode: "Markdown" });
}

/** Step 1b (alt): User backed out → dismiss, the date stays on. */
export async function handleEmergencyAbort(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("emerg:abort:")) return;

  await ctx.answerCallbackQuery();

  const lang = ctx.session.language;
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply(t(lang, "emergencyAborted"));
}

/**
 * Step 2: User sends the free-text cancellation reason.
 * Quote the *exact* text to the other person, cancel the match.
 */
export async function handleEmergencyReason(ctx: BotContext): Promise<void> {
  const reason = ctx.message?.text;
  if (!reason) return;

  const matchId = ctx.session.activeMatchId;
  if (!matchId) return;

  // Reset session state immediately.
  ctx.session.matchFlow = "idle";
  ctx.session.activeMatchId = null;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match || match.status !== "scheduled") return;

  const isA = user.id === match.userAId;
  const isB = user.id === match.userBId;
  if (!isA && !isB) return;

  const forwardedReason = reason.slice(0, 1000);

  // Persist cancellation.
  await prisma.match.update({
    where: { id: matchId },
    data: {
      status: "cancelled",
      emergencyCancelledBy: user.id,
      emergencyReason: forwardedReason,
    },
  });

  const otherUserId = isA ? match.userBId : match.userAId;
  await applyEmergencyCancellationPeerBoost(otherUserId);

  // The date isn't happening, so every paid ticket goes back to its payer —
  // including this user's, who cancelled honestly (PRODUCT_SPEC §3.5b). Safe as
  // a plain post-cancel call: the ticket-expiry rail only touches `negotiating`
  // rows, and this path only ever cancels a `scheduled` one.
  const refunds = await refundMatchTickets(matchId).catch((err: unknown) => {
    console.warn("[emergency] ticket refund failed:", err);
    return [];
  });
  const refundLineFor = (userId: string, refundLang: Language): string => {
    const key = ticketRefundNoticeKey(
      refunds.find((r) => r.userId === userId)?.refunded ?? 0,
    );
    return key ? `\n\n${t(refundLang, key)}` : "";
  };

  const lang = ctx.session.language;
  await ctx.reply(`${t(lang, "emergencyConfirmed")}${refundLineFor(user.id, lang)}`);

  // Quote exact reason to the other person — Telegram side only. Mobile
  // peers see the cancellation via the `/v1/matches/current` poll, plus a
  // push notification dispatched separately.
  const other = isA ? match.userB : match.userA;
  if (other.telegramId > 0n) {
    const otherLang = (other.language ?? "en") as Language;
    const notice = buildEmergencyCancellationNotice(otherLang, forwardedReason);
    // Appended AFTER the quote, so the blockquote entity's offset/length still
    // line up with the verbatim reason.
    const noticeText = `${notice.text}${refundLineFor(otherUserId, otherLang)}`;
    // The body is this user's free text, quoted verbatim into someone else's
    // chat. That chat's timeline is read back into THEIR menu agent's system
    // prompt, next to tools that write to their profile — so the timeline gets
    // a neutral marker and never the text itself. The recipient still sees the
    // full quote in Telegram; only the agent's context is kept clean.
    await withRedactedSummary(
      "(partner sent a reason for cancelling the date — the full text was shown to the user)",
      () =>
        ctx.api.sendMessage(Number(other.telegramId), noticeText, {
          entities: notice.entities,
        }),
    ).catch((err: unknown) => {
      console.warn(
        `[emergency] forward failed for ${other.telegramId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}
