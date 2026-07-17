import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { createMatchEventBestEffort } from "../../services/match-events.js";
import { startScheduling } from "./scheduler.js";
import { sendTicketOffer } from "./ticket-gate.js";
import { updateEloScores } from "../../utils/elo-calculator.js";
import { buildDeclineReasonKeyboard } from "./decline-feedback.js";
import { syncTelegramUsername } from "../../utils/username.js";
import {
  boostAcceptedSidePriority,
  outcomeRevealKey,
} from "../../services/match-decision-shared.js";
import { claimMatchDecision } from "../../services/match-decision-claim.js";
import { sendOrEditPostAcceptMessage } from "./post-accept-message.js";

/**
 * Match decision handler — Accept / Decline.
 *
 * Callback data formats:
 *   - `match:accept:{matchId}`     — commits an Accept immediately (no guard).
 *   - `match:decline:{matchId}`    — produced by `buildMatchKeyboard`; does NOT
 *     commit. It opens a confirmation card (`promptDeclineConfirm`) because a
 *     pass is irreversible (lifetime no-repeat — the pair is never shown again),
 *     so an accidental tap must not throw the match away.
 *   - `match:do:decline:{matchId}` — the confirmed Decline commit (the red
 *     "Yes, pass" button on the confirmation card).
 *   - `match:keep:{matchId}`       — backs out of the confirmation card; no
 *     state change, the live pitch keyboard is still there to tap.
 *
 * Blind-decision invariant
 * ------------------------
 * A user MUST NOT learn what their partner picked until they themselves
 * have committed to a choice. This drives two behaviors:
 *
 *   1. When the first side commits (accept OR decline), the row stays in
 *      `proposed` status — we do NOT flip to `cancelled` on a single
 *      decline. The peer's keyboard remains live; the match only "dies"
 *      when both have decided or the 24h TTL expires.
 *
 *   2. When the first side commits, we DM the peer a neutral nudge
 *      (`matchPeerDecided`) — "your partner answered, your turn". It
 *      reveals nothing about the answer itself.
 *
 *   3. The reveal happens at the moment the peer taps their own button:
 *      together with the standard accept/decline reply, we append a
 *      `matchPeerWasAccepted` / `matchPeerWasDeclined` line.
 *
 * Status transitions:
 *   - First commit (peer not yet decided): row stays `proposed`. Nudge.
 *   - Both accepted: atomic flip `proposed → negotiating`. Mutual reveal
 *     via `matchBothAccepted` + handoff to scheduler.
 *   - Mixed (one accept, one decline) or both declined: status flips to
 *     `cancelled`. The second-deciding user gets the reveal in their
 *     reply; the first-deciding user (who saw `matchAccepted` /
 *     `matchDeclined` earlier) is also notified now via a follow-up DM
 *     so both sides ultimately learn the outcome.
 */

type Side = "A" | "B";

interface MatchView {
  id: string;
  userAId: string;
  userBId: string;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  status: string;
  calendarMessageIdA: number | null;
  calendarMessageIdB: number | null;
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
      calendarMessageIdA: true,
      calendarMessageIdB: true,
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

function peerLangOf(match: MatchView, side: Side): Language {
  return ((side === "A" ? match.userB.language : match.userA.language) ?? "en") as Language;
}

function peerTelegramIdOf(match: MatchView, side: Side): bigint {
  return side === "A" ? match.userB.telegramId : match.userA.telegramId;
}

function actorTelegramIdOf(match: MatchView, side: Side): bigint {
  return side === "A" ? match.userA.telegramId : match.userB.telegramId;
}

function postAcceptMessageIdOf(match: MatchView, side: Side): number | null {
  return side === "A"
    ? match.calendarMessageIdA ?? null
    : match.calendarMessageIdB ?? null;
}

/**
 * Build the decline confirmation card's keyboard: a red "Yes, pass" commit
 * over a neutral "Go back". Raw markup (not grammY's builder) so the Bot API
 * 9.4 `style` field rides the confirm button, mirroring `buildMatchKeyboard`.
 */
export function buildDeclineConfirmKeyboard(
  matchId: string,
  lang: Language,
): InlineKeyboardMarkup {
  const confirmBtn: InlineKeyboardButton.CallbackButton & Record<string, unknown> = {
    text: t(lang, "matchBtnConfirmDecline"),
    callback_data: `match:do:decline:${matchId}`,
    style: "danger",
    ...(env.CUSTOM_EMOJI_DECLINE_ID ? { icon_custom_emoji_id: env.CUSTOM_EMOJI_DECLINE_ID } : {}),
  };

  const backBtn: InlineKeyboardButton.CallbackButton = {
    text: t(lang, "matchBtnKeepDeciding"),
    callback_data: `match:keep:${matchId}`,
  };

  return {
    inline_keyboard: [[confirmBtn as InlineKeyboardButton], [backBtn]],
  };
}

/**
 * First tap on the pitch's `[Pass]` button. Does NOT commit — surfaces an
 * explicit confirmation card so an accidental tap can't irreversibly throw the
 * match away. The blind-decision invariant is unaffected: the card reveals
 * nothing about the partner's choice, and no state changes until the user
 * confirms. The live pitch keyboard stays in place behind the card.
 */
export async function promptDeclineConfirm(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("match:decline:")) return;
  const matchId = data.slice("match:decline:".length);
  if (!matchId) return;

  await ctx.answerCallbackQuery();

  const match = await loadMatch(matchId);
  // Only a still-live proposal can be passed on; a resolved/expired row no-ops.
  if (!match || match.status !== "proposed") return;
  const side = await sideForCaller(ctx, match);
  if (!side) return;

  const lang = ctx.session.language;
  await ctx.reply(t(lang, "matchDeclineConfirmPrompt"), {
    parse_mode: "Markdown",
    reply_markup: buildDeclineConfirmKeyboard(matchId, lang),
  });
}

/**
 * User backed out of the decline confirmation card. No state changes; edit the
 * card into a dismissed line so its button can't be tapped again. The original
 * pitch keyboard is still live for a real Accept/Pass.
 */
export async function handleDeclineBack(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("match:keep:")) return;

  await ctx.answerCallbackQuery();

  const lang = ctx.session.language;
  const dismissed = t(lang, "matchDeclineDismissed");
  try {
    await ctx.editMessageText(dismissed);
  } catch {
    await ctx.reply(dismissed).catch(() => {});
  }
}

export async function handleMatchDecision(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  // Accept commits immediately; Decline only ever reaches here as the confirmed
  // `match:do:decline:` commit (the bare `match:decline:` tap is intercepted by
  // `promptDeclineConfirm`).
  let action: "accept" | "decline";
  let matchId: string;
  let fromConfirmCard = false;
  if (data.startsWith("match:accept:")) {
    action = "accept";
    matchId = data.slice("match:accept:".length);
  } else if (data.startsWith("match:do:decline:")) {
    action = "decline";
    matchId = data.slice("match:do:decline:".length);
    fromConfirmCard = true;
  } else {
    return;
  }
  if (!matchId) return;

  await ctx.answerCallbackQuery({
    text: t(
      ctx.session.language,
      action === "accept" ? "matchAcceptedToast" : "matchDecisionSavedToast",
    ),
  });

  // The confirmation card carries a single live button. Strip its keyboard the
  // moment it's tapped so a double-tap can't re-enter the commit path (which is
  // already idempotent, but this keeps the chat clean).
  if (fromConfirmCard) {
    await ctx.editMessageReplyMarkup().catch(() => {});
  }

  const match = await loadMatch(matchId);
  if (!match) return;
  // Blind-decision keeps the row in `proposed` until both sides decide,
  // so the only ways a callback should arrive on a non-proposed row are:
  //   - the user's own decision raced (their second tap on the same row),
  //     in which case the row is already `cancelled` / `negotiating` /
  //     `expired` and we should no-op,
  //   - or the row is `completed` (date already happened).
  if (match.status !== "proposed") return;

  const side = await sideForCaller(ctx, match);
  if (!side) return;

  if (action === "accept") {
    // Capture the public Telegram username on the path to every scheduled date,
    // so the pre-date coordination offer can build a `t.me/<username>` link
    // without a fresh /start. Best-effort, never blocks the decision.
    void syncTelegramUsername(BigInt(ctx.from!.id), ctx.from?.username).catch(() => {});
    await handleAccept(ctx, match, side);
    return;
  }
  await handleDecline(ctx, match, side);
}

/**
 * Notify the peer that the actor just committed an answer — without
 * revealing which one. Sent only on the first decision per match.
 * Keyed off the prior `peerAccepted` value: `null` means peer hadn't yet
 * decided, so this actor is the "first decider" and the nudge fires.
 */
async function sendPeerDecidedNudge(
  ctx: BotContext,
  match: MatchView,
  side: Side,
): Promise<void> {
  const peerLang = peerLangOf(match, side);
  const peerTelegramId = peerTelegramIdOf(match, side);
  try {
    await ctx.api.sendMessage(
      Number(peerTelegramId),
      t(peerLang, "matchPeerDecided"),
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.warn("[decision] peer-decided nudge failed:", (err as Error).message);
  }
}

/**
 * Send the actor a follow-up reveal of the peer's prior decision. Used
 * when the actor is the SECOND decider on a match that's about to be
 * cancelled (mixed verdict or both-declined). The mutual-accept case
 * has its own positive message (`matchBothAccepted`) and skips this.
 */
async function sendActorReveal(
  ctx: BotContext,
  peerPrior: boolean | null,
  lang: Language,
  actorAccepted: boolean,
  acceptedSidePriorityBoosted: boolean,
): Promise<void> {
  if (peerPrior === null) return;
  const key = outcomeRevealKey(actorAccepted, peerPrior, acceptedSidePriorityBoosted);
  await ctx.reply(t(lang, key));
}

/**
 * Notify the FIRST decider (the peer in this handler's frame of
 * reference) of the final outcome once the actor commits. Both sides
 * eventually learn the full result — the first decider sees it as a
 * delayed DM, the second sees it inline.
 */
async function sendPeerOutcomeReveal(
  ctx: BotContext,
  match: MatchView,
  side: Side,
  peerAccepted: boolean,
  actorAccepted: boolean,
  acceptedSidePriorityBoosted: boolean,
): Promise<void> {
  const peerLang = peerLangOf(match, side);
  const peerTelegramId = peerTelegramIdOf(match, side);
  const key = outcomeRevealKey(peerAccepted, actorAccepted, acceptedSidePriorityBoosted);
  try {
    await ctx.api.sendMessage(Number(peerTelegramId), t(peerLang, key));
  } catch (err) {
    console.warn("[decision] peer outcome reveal failed:", (err as Error).message);
  }
}

async function handleAccept(
  ctx: BotContext,
  match: MatchView,
  side: Side,
): Promise<void> {
  const lang = ctx.session.language;
  const actorId = side === "A" ? match.userAId : match.userBId;
  const targetId = side === "A" ? match.userBId : match.userAId;
  const claimed = await claimMatchDecision({
    matchId: match.id,
    side,
    decision: true,
  });
  if (!claimed.claimed) return;
  const peerPrior = side === "A" ? claimed.acceptedByB : claimed.acceptedByA;
  await createMatchEventBestEffort({
    matchId: match.id,
    actorId,
    targetId,
    actionType: "ACCEPTED",
  });

  // Bot API 9.3: attach a visual message effect to accept confirmations.
  const effectId = env.MESSAGE_EFFECT_MATCH_ID || undefined;

  // Mutual accept → flip to negotiating + scheduler handoff.
  if (claimed.acceptedByA === true && claimed.acceptedByB === true) {
    // Atomic transition: only one concurrent caller wins the race.
    // The WHERE clause ensures only a match still in "proposed" state
    // can be flipped to "negotiating", preventing double startScheduling.
    const transitioned = await prisma.match.updateMany({
      where: { id: match.id, status: "proposed" },
      data: { status: "negotiating" },
    });
    if (transitioned.count === 0) {
      // The other caller already transitioned and owns the ticket/calendar
      // handoff. The callback toast above is enough here.
      return;
    }
    // Mutual accept → both gain Elo. Only the caller that wins the
    // status-transition race performs the update so the rating change
    // happens exactly once per match.
    await updateEloScores(match.userAId, match.userBId, true, true);
    // Date Ticket gate: when enabled, both users must pay (mock) for a ticket
    // before scheduling unlocks. When disabled (default), hand off straight to
    // the Calendar Mini App exactly as before. Telegram-only in v1.
    if (env.TICKET_FEATURE_ENABLED) {
      await sendTicketOffer(ctx.api, match.id);
    } else {
      await startScheduling(ctx.api, match.id);
    }
    return;
  }

  // Peer had already declined → mixed verdict. Cancel the match and
  // reveal the peer's earlier decline to the actor (who's now committed).
  // The first decider already saw `matchDeclined` so we tell them via
  // a follow-up reveal too.
  if (peerPrior === false) {
    // The actor's own acknowledgement belongs to their successfully claimed
    // decision and is safe to send even if the peer wins the terminal CAS.
    await ctx
      .reply(t(lang, "matchAccepted"), {
        ...(effectId ? { message_effect_id: effectId } : {}),
      })
      .catch(() => {});
    const transitioned = await prisma.match.updateMany({
      where: { id: match.id, status: "proposed" },
      data: { status: "cancelled" },
    });
    if (transitioned.count === 0) return;
    // Elo: actor accepted, peer declined earlier. Use the existing
    // `updateEloScores` semantics — accepted=true, declined=false.
    const aDecision: boolean = side === "A" ? true : false;
    const bDecision: boolean = side === "B" ? true : false;
    await updateEloScores(match.userAId, match.userBId, aDecision, bDecision);
    const acceptedSidePriorityBoosted = await boostAcceptedSidePriority(actorId);
    await sendActorReveal(ctx, peerPrior, lang, true, acceptedSidePriorityBoosted);
    await sendPeerOutcomeReveal(ctx, match, side, peerPrior, true, acceptedSidePriorityBoosted);
    return;
  }

  // Peer hasn't decided yet → first-decider path. Stay in `proposed`,
  // ack the actor, fire the blind nudge to the peer.
  await sendOrEditPostAcceptMessage({
    api: ctx.api,
    matchId: match.id,
    side,
    telegramId: actorTelegramIdOf(match, side),
    previousMessageId: postAcceptMessageIdOf(match, side),
    text: t(lang, "matchAccepted"),
    options: {
      ...(effectId ? { message_effect_id: effectId } : {}),
    },
  });
  await sendPeerDecidedNudge(ctx, match, side);
}

async function handleDecline(
  ctx: BotContext,
  match: MatchView,
  side: Side,
): Promise<void> {
  const lang = ctx.session.language;
  const actorId = side === "A" ? match.userAId : match.userBId;
  const targetId = side === "A" ? match.userBId : match.userAId;
  const claimed = await claimMatchDecision({
    matchId: match.id,
    side,
    decision: false,
  });
  if (!claimed.claimed) return;
  const peerPrior = side === "A" ? claimed.acceptedByB : claimed.acceptedByA;

  await createMatchEventBestEffort({
    matchId: match.id,
    actorId,
    targetId,
    actionType: "DECLINED",
  });

  // Every successfully claimed decline gets its own acknowledgement/feedback
  // affordance. Terminal Elo/priority/reveal effects below belong only to the
  // single caller that wins proposed -> cancelled.
  await ctx
    .reply(t(lang, "matchDeclined"), {
      reply_markup: buildDeclineReasonKeyboard(match.id, lang),
    })
    .catch(() => {});

  if (peerPrior !== null) {
    const transitioned = await prisma.match.updateMany({
      where: { id: match.id, status: "proposed" },
      data: { status: "cancelled" },
    });
    if (transitioned.count === 0) return;
  }

  // Elo: actor's verdict is locked in (false). Peer's prior verdict is
  // either null (first decider — Elo update deferred to expiry job) or
  // a concrete true/false. We only update Elo when both sides have
  // committed — same rule as the legacy code, just centralised here.
  if (peerPrior !== null) {
    const aDecision: boolean = side === "A" ? false : peerPrior;
    const bDecision: boolean = side === "B" ? false : peerPrior;
    await updateEloScores(match.userAId, match.userBId, aDecision, bDecision);
  }

  if (peerPrior === null) {
    // Blind nudge — peer doesn't yet know which way the actor went.
    await sendPeerDecidedNudge(ctx, match, side);
    return;
  }

  // Both have now decided → reveal both ways.
  const acceptedSidePriorityBoosted =
    peerPrior === true ? await boostAcceptedSidePriority(targetId) : false;
  await sendActorReveal(ctx, peerPrior, lang, false, acceptedSidePriorityBoosted);
  await sendPeerOutcomeReveal(ctx, match, side, peerPrior, false, acceptedSidePriorityBoosted);
}
