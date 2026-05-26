import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { MessageEntity } from "grammy/types";
import type { BotContext } from "../../session.js";
import { applyEmergencyCancellationPeerBoost } from "../../utils/elo-calculator.js";

/**
 * Emergency cancellation flow (PRODUCT_SPEC.md §Phase 4.2).
 *
 * Callback `emerg:start:{matchId}` — user taps the "Cancel date" button
 * that was sent by the date-lifecycle cron 3h before the date.
 *
 * The handler sets session state to `awaiting_emergency_reason` and waits
 * for a free-text message, which is then quoted *exactly as-is* to the other
 * person with a short Gennety note below it.
 */

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

/** Step 1: User taps the emergency button → ask for reason. */
export async function handleEmergencyStart(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("emerg:start:")) return;

  const matchId = data.slice("emerg:start:".length);
  if (!matchId) return;

  await ctx.answerCallbackQuery();

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
  if (!match || match.status !== "scheduled" || match.emergencyCancelledBy) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const isParticipant = user.id === match.userAId || user.id === match.userBId;
  if (!isParticipant) return;

  ctx.session.matchFlow = "awaiting_emergency_reason";
  ctx.session.activeMatchId = matchId;

  const lang = ctx.session.language;
  await ctx.reply(t(lang, "emergencyAskReason"), { parse_mode: "Markdown" });
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

  const lang = ctx.session.language;
  await ctx.reply(t(lang, "emergencyConfirmed"));

  // Quote exact reason to the other person — Telegram side only. Mobile
  // peers see the cancellation via the `/v1/matches/current` poll, plus a
  // push notification dispatched separately.
  const other = isA ? match.userB : match.userA;
  if (other.telegramId > 0n) {
    const otherLang = (other.language ?? "en") as Language;
    const notice = buildEmergencyCancellationNotice(otherLang, forwardedReason);
    await ctx.api
      .sendMessage(Number(other.telegramId), notice.text, { entities: notice.entities })
      .catch((err: unknown) => {
        console.warn(
          `[emergency] forward failed for ${other.telegramId}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }
}
