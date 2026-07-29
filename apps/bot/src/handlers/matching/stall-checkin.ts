import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  STALL_ASK_CANCEL_PREFIX,
  STALL_CANCEL_BACK_PREFIX,
  STALL_CANCEL_CONFIRM_PREFIX,
  STALL_MATCH_SELECT,
  STALL_OK_PREFIX,
  buildStallCancelConfirmKeyboard,
  cancelPlanningByUser,
  sideOwesAction,
  stallPhaseOf,
  stallReachableFor,
  type MatchSide,
} from "../../services/match-stall.js";

/**
 * The "still in?" check-in answers, and the planning-stage cancellation they
 * (and the concierge agent) lead to. PRODUCT_SPEC §3.5c.
 *
 * Deliberately asymmetric, per founder decision: 🟢 commits instantly because
 * it changes nothing the user could regret, while the red path always goes
 * through a confirmation card with a way back — cancelling is irreversible under
 * the lifetime pair ban, so it gets the same treatment as passing on a pitch.
 */

interface StallActor {
  matchId: string;
  userId: string;
  side: MatchSide;
  lang: Language;
}

/**
 * Shared guard: resolve the tapping user against a still-live planning match.
 * Returns null whenever the action should be a silent no-op — an unknown user, a
 * non-participant, or a match that has already moved on (someone answered, the
 * timeout fired, moderation stepped in).
 */
async function resolveStallActor(
  ctx: BotContext,
  matchId: string,
): Promise<StallActor | null> {
  const fromId = ctx.from?.id;
  if (!matchId || !fromId) return null;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(fromId) },
    select: { id: true, language: true },
  });
  if (!user) return null;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: STALL_MATCH_SELECT,
  });
  if (!match || !stallPhaseOf(match)) return null;

  const side: MatchSide | null =
    match.userAId === user.id ? "A" : match.userBId === user.id ? "B" : null;
  if (!side) return null;

  return {
    matchId,
    userId: user.id,
    side,
    lang: (user.language ?? ctx.session.language ?? "en") as Language,
  };
}

/**
 * 🟢 "Still on" — commits immediately, no confirmation.
 *
 * Pushes this side's 48h deadline out from now, and re-arms the question exactly
 * once so a genuinely busy person gets a second chance to say so. The re-arm is
 * gated on this being the FIRST confirmation, which is what bounds the chain at
 * two questions.
 *
 * Replay-safe by construction: the write is a compare-and-set on the
 * `stallConfirmedAt*` value that was read, and eligibility requires the
 * confirmation to be older than the question it answers. So each sent question
 * can be confirmed exactly once, and tapping green on a stale message can never
 * keep pushing the deadline forward.
 */
export async function handleStallStillOn(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(STALL_OK_PREFIX)) return;
  const matchId = data.slice(STALL_OK_PREFIX.length);

  await ctx.answerCallbackQuery();

  const actor = await resolveStallActor(ctx, matchId);
  if (!actor) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: STALL_MATCH_SELECT,
  });
  if (!match) return;

  const isA = actor.side === "A";
  const asked = isA ? match.stallCheckInSentAtA : match.stallCheckInSentAtB;
  const confirmed = isA ? match.stallConfirmedAtA : match.stallConfirmedAtB;

  // No live question to answer (or it was answered already).
  if (!asked) return;
  if (confirmed && confirmed >= asked) return;

  const now = new Date();
  const firstConfirmation = confirmed === null;

  const claim = await prisma.match.updateMany({
    where: {
      id: matchId,
      status: match.status,
      ...(isA ? { stallConfirmedAtA: confirmed } : { stallConfirmedAtB: confirmed }),
    },
    data: isA
      ? {
          stallConfirmedAtA: now,
          ...(firstConfirmation ? { stallCheckInSentAtA: null } : {}),
        }
      : {
          stallConfirmedAtB: now,
          ...(firstConfirmation ? { stallCheckInSentAtB: null } : {}),
        },
  });
  if (claim.count === 0) return;

  // The question is answered — drop its buttons so it stops looking open.
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply(t(actor.lang, "stallStillOnAck"));

  // Reassure the side that was waiting. Skipped when they also owe something —
  // they aren't waiting on anyone, they're the other half of the same silence.
  const partner = isA ? match.userB : match.userA;
  if (sideOwesAction(match, isA ? "B" : "A")) return;
  if (!stallReachableFor(partner.telegramId)) return;

  const partnerLang = (partner.language ?? "en") as Language;
  const actorUser = isA ? match.userA : match.userB;
  const label = actorUser.firstName ?? t(partnerLang, "stallPartnerFallbackName");
  await ctx.api
    .sendMessage(
      Number(partner.telegramId),
      t(partnerLang, "stallPeerStillOn", { name: label }),
    )
    .catch((err: unknown) => {
      console.warn(
        `[stall] still-on notice failed for ${partner.telegramId}:`,
        err instanceof Error ? err.message : err,
      );
    });
}

/**
 * Red button, or the concierge agent's surfaced entry — open the confirmation
 * card. Touches no state, so a stray tap (or an agent that misread the request)
 * costs nothing.
 */
export async function handleStallAskCancel(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(STALL_ASK_CANCEL_PREFIX)) return;
  const matchId = data.slice(STALL_ASK_CANCEL_PREFIX.length);

  await ctx.answerCallbackQuery();

  const actor = await resolveStallActor(ctx, matchId);
  if (!actor) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { userAId: true, userA: { select: { firstName: true } }, userB: { select: { firstName: true } } },
  });
  if (!match) return;

  const partner = actor.side === "A" ? match.userB : match.userA;
  const name = partner.firstName ?? t(actor.lang, "stallPartnerFallbackName");

  await ctx.reply(t(actor.lang, "stallCancelConfirmPrompt", { name }), {
    reply_markup: buildStallCancelConfirmKeyboard(matchId, actor.lang),
  });
}

/** Backed out of the confirmation card — nothing was touched, say so plainly. */
export async function handleStallCancelBack(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(STALL_CANCEL_BACK_PREFIX)) return;

  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply(t(ctx.session.language, "stallCancelAborted"));
}

/**
 * The confirmed cancellation. No penalty for the person who pressed it: this is
 * the behaviour the whole check-in exists to produce, and pricing it would make
 * silence the cheaper option.
 */
export async function handleStallCancelConfirm(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(STALL_CANCEL_CONFIRM_PREFIX)) return;
  const matchId = data.slice(STALL_CANCEL_CONFIRM_PREFIX.length);

  await ctx.answerCallbackQuery();

  const actor = await resolveStallActor(ctx, matchId);
  if (!actor) return;

  await ctx.editMessageReplyMarkup().catch(() => {});

  const outcome = await cancelPlanningByUser(ctx.api, matchId, actor.userId);
  if (!outcome.cancelled || !outcome.ackText) return;

  await ctx.reply(outcome.ackText);
}
