import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { startScheduling } from "./scheduler.js";

/**
 * Match decision handler — Accept / Decline.
 *
 * Callback data formats (produced by `buildMatchKeyboard`):
 *   - `match:accept:{matchId}`
 *   - `match:decline:{matchId}`
 *
 * Flow:
 *   - Accept: set `acceptedByA/B` to true. If both true → transition to
 *     `negotiating` and hand off to the scheduler.
 *   - Decline: set `acceptedByA/B` to false, flip match status to
 *     `cancelled`. The user is prompted for a reason via reply text.
 *     The menu agent picks up the pending rejection via the system-prompt
 *     hint from `prompt-builder` and calls `record_rejection_feedback`.
 *     We also notify the peer that their match passed.
 */

type Side = "A" | "B";

interface MatchView {
  id: string;
  userAId: string;
  userBId: string;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  status: string;
  userA: { telegramId: bigint; language: string | null };
  userB: { telegramId: bigint; language: string | null };
}

async function loadMatch(matchId: string): Promise<MatchView | null> {
  return prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      acceptedByA: true,
      acceptedByB: true,
      status: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
}

/** Determine which side of the match the acting user is on. */
async function sideForCaller(
  ctx: BotContext,
  match: MatchView,
): Promise<Side | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return null;
  if (user.id === match.userAId) return "A";
  if (user.id === match.userBId) return "B";
  return null;
}

export async function handleMatchDecision(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("match:")) return;

  const [, action, matchId] = data.split(":");
  if (!matchId || (action !== "accept" && action !== "decline")) return;

  await ctx.answerCallbackQuery();

  const match = await loadMatch(matchId);
  if (!match || match.status === "cancelled" || match.status === "completed") return;

  const side = await sideForCaller(ctx, match);
  if (!side) return;

  if (action === "accept") {
    await handleAccept(ctx, match, side);
    return;
  }
  await handleDecline(ctx, match, side);
}

async function handleAccept(
  ctx: BotContext,
  match: MatchView,
  side: Side,
): Promise<void> {
  const lang = ctx.session.language;
  const updated = await prisma.match.update({
    where: { id: match.id },
    data: side === "A" ? { acceptedByA: true } : { acceptedByB: true },
    select: { id: true, acceptedByA: true, acceptedByB: true },
  });

  // Bot API 9.3: attach a visual message effect to accept confirmations.
  const effectId = env.MESSAGE_EFFECT_MATCH_ID || undefined;

  if (updated.acceptedByA === true && updated.acceptedByB === true) {
    // Atomic transition: only one concurrent caller wins the race.
    // The WHERE clause ensures only a match still in "proposed" state
    // can be flipped to "negotiating", preventing double startScheduling.
    const transitioned = await prisma.match.updateMany({
      where: { id: match.id, status: "proposed" },
      data: { status: "negotiating" },
    });
    if (transitioned.count === 0) {
      // The other caller already transitioned — just ack.
      await ctx.reply(t(lang, "matchAccepted"), {
        ...(effectId ? { message_effect_id: effectId } : {}),
      });
      return;
    }
    // Notify both users and kick off iteration 1.
    await ctx.reply(t(lang, "matchBothAccepted"), {
      ...(effectId ? { message_effect_id: effectId } : {}),
    });
    const peerTelegramId = side === "A" ? match.userB.telegramId : match.userA.telegramId;
    const peerLang = (side === "A" ? match.userB.language : match.userA.language) ?? "en";
    await ctx.api.sendMessage(
      Number(peerTelegramId),
      t(peerLang as "en" | "ru" | "uk", "matchBothAccepted"),
      ...(effectId ? [{ message_effect_id: effectId }] : []),
    );
    await startScheduling(ctx.api, match.id);
    return;
  }

  await ctx.reply(t(lang, "matchAccepted"), {
    ...(effectId ? { message_effect_id: effectId } : {}),
  });
}

async function handleDecline(
  ctx: BotContext,
  match: MatchView,
  side: Side,
): Promise<void> {
  const lang = ctx.session.language;
  await prisma.match.update({
    where: { id: match.id },
    data:
      side === "A"
        ? { acceptedByA: false, status: "cancelled" }
        : { acceptedByB: false, status: "cancelled" },
  });

  await ctx.reply(t(lang, "matchDeclined"), { parse_mode: "Markdown" });

  // Notify the peer their match passed.
  const peerTelegramId = side === "A" ? match.userB.telegramId : match.userA.telegramId;
  const peerLang = (side === "A" ? match.userB.language : match.userA.language) ?? "en";
  try {
    await ctx.api.sendMessage(Number(peerTelegramId), t(peerLang as "en" | "ru" | "uk", "matchOtherDeclined"));
  } catch (err) {
    console.warn("Failed to notify peer of decline:", err);
  }
}
