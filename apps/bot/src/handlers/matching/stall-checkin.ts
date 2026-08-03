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
  stallAnchorAt,
  stallCheckInAskedAt,
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

type StallMatch = Awaited<ReturnType<typeof loadStallMatch>>;

async function loadStallMatch(matchId: string) {
  return prisma.match.findUnique({ where: { id: matchId }, select: STALL_MATCH_SELECT });
}

interface StallActor {
  matchId: string;
  userId: string;
  side: MatchSide;
  lang: Language;
  /** The row the guard already read — callers must not re-fetch it. */
  match: NonNullable<StallMatch>;
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

  const match = await loadStallMatch(matchId);
  if (!match) return null;

  const side: MatchSide | null =
    match.userAId === user.id ? "A" : match.userBId === user.id ? "B" : null;
  if (!side) return null;

  const lang = (user.language ?? ctx.session.language ?? "en") as Language;

  // The check-in message keeps its buttons indefinitely — nothing deletes it
  // when the match resolves, and the 48h cancellation doesn't know its id. So a
  // tap on a dead button is a normal thing to happen, and it has to SAY
  // something: swallowing it silently reads as the bot being broken, on the one
  // screen whose entire job is to prove that it isn't.
  //
  // This is also why the callback is answered HERE rather than eagerly at the
  // top of each handler: a query can only be answered once, so an eager plain
  // answer would make this alert impossible.
  if (!stallPhaseOf(match)) {
    await ctx.answerCallbackQuery({ text: t(lang, "stallActionExpired"), show_alert: true });
    // The buttons are provably dead now, so take them with it where we can.
    await ctx.editMessageReplyMarkup().catch(() => {});
    return null;
  }

  await ctx.answerCallbackQuery();
  return { matchId, userId: user.id, side, lang, match };
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

  const actor = await resolveStallActor(ctx, matchId);
  if (!actor) return;

  // Reuse the guard's row rather than reading again: two reads mean two
  // different snapshots, and the eligibility check below compares timestamps
  // across them.
  const match = actor.match;
  const isA = actor.side === "A";
  const confirmed = isA ? match.stallConfirmedAtA : match.stallConfirmedAtB;

  // No live question to answer — none sent in THIS phase, or already answered.
  const asked = stallCheckInAskedAt(match, actor.side);
  if (!asked) return;
  if (confirmed && confirmed >= asked) return;

  const now = new Date();
  // "First confirmation IN THIS PHASE" — measured against the phase anchor, not
  // against the question. Anchor-relative keeps the two-question cap per phase
  // (a second green in the same phase does not re-arm, so the chain can't be
  // held open forever); question-relative would make every answered question
  // re-arm, which is an unbounded loop. And a confirmation left over from the
  // scheduling step sits at or before the venue anchor, so it correctly does not
  // spend the venue step's single re-arm.
  const anchor = stallAnchorAt(match);
  const firstConfirmation = confirmed === null || (anchor !== null && confirmed <= anchor);

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

  const actor = await resolveStallActor(ctx, matchId);
  if (!actor) return;

  const partner = actor.side === "A" ? actor.match.userB : actor.match.userA;
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

  const actor = await resolveStallActor(ctx, matchId);
  if (!actor) return;

  await ctx.editMessageReplyMarkup().catch(() => {});

  const outcome = await cancelPlanningByUser(ctx.api, matchId, actor.userId);
  if (!outcome.cancelled || !outcome.ackText) {
    // The match moved on between the guard's read and the CAS (the partner
    // answered, the 48h timeout fired, moderation stepped in). Rare, but the
    // user just tapped a red irreversible button and watched its keyboard
    // vanish — saying nothing reads as the tap having silently worked.
    await ctx.reply(t(actor.lang, "stallActionExpired"));
    return;
  }

  await ctx.reply(outcome.ackText);
}
