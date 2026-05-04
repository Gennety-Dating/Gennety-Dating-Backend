import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { createMatchEvent } from "../../services/match-events.js";
import { startScheduling } from "./scheduler.js";
import { updateEloScores } from "../../utils/elo-calculator.js";

/**
 * Match decision handler — Accept / Decline.
 *
 * Callback data formats (produced by `buildMatchKeyboard`):
 *   - `match:accept:{matchId}`
 *   - `match:decline:{matchId}`
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

function peerLangOf(match: MatchView, side: Side): Language {
  return ((side === "A" ? match.userB.language : match.userA.language) ?? "en") as Language;
}

function peerTelegramIdOf(match: MatchView, side: Side): bigint {
  return side === "A" ? match.userB.telegramId : match.userA.telegramId;
}

function peerPriorAccepted(match: MatchView, side: Side): boolean | null {
  return side === "A" ? match.acceptedByB : match.acceptedByA;
}

export async function handleMatchDecision(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("match:")) return;

  const [, action, matchId] = data.split(":");
  if (!matchId || (action !== "accept" && action !== "decline")) return;

  await ctx.answerCallbackQuery();

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

  // Reject double-tap from the same side: if this user already has a
  // decision recorded, ignore the second click instead of overwriting it.
  // Their decision was final the moment they first tapped.
  const ownPrior = side === "A" ? match.acceptedByA : match.acceptedByB;
  if (ownPrior !== null) return;

  if (action === "accept") {
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
): Promise<void> {
  if (peerPrior === null) return;
  const key = peerPrior ? "matchPeerWasAccepted" : "matchPeerWasDeclined";
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
  actorAccepted: boolean,
): Promise<void> {
  const peerLang = peerLangOf(match, side);
  const peerTelegramId = peerTelegramIdOf(match, side);
  const key = actorAccepted ? "matchPeerWasAccepted" : "matchPeerWasDeclined";
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
  const peerPrior = peerPriorAccepted(match, side);

  const updated = await prisma.match.update({
    where: { id: match.id },
    data: side === "A" ? { acceptedByA: true } : { acceptedByB: true },
    select: { id: true, acceptedByA: true, acceptedByB: true },
  });
  await createMatchEvent({
    matchId: match.id,
    actorId,
    targetId,
    actionType: "ACCEPTED",
  });

  // Bot API 9.3: attach a visual message effect to accept confirmations.
  const effectId = env.MESSAGE_EFFECT_MATCH_ID || undefined;

  // Mutual accept → flip to negotiating + scheduler handoff.
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
      await ctx.reply(t(lang, "matchBothAccepted"), {
        ...(effectId ? { message_effect_id: effectId } : {}),
      });
      return;
    }
    // Mutual accept → both gain Elo. Only the caller that wins the
    // status-transition race performs the update so the rating change
    // happens exactly once per match.
    await updateEloScores(match.userAId, match.userBId, true, true);
    // Notify both users and kick off iteration 1.
    await ctx.reply(t(lang, "matchBothAccepted"), {
      ...(effectId ? { message_effect_id: effectId } : {}),
    });
    const peerTelegramId = peerTelegramIdOf(match, side);
    const peerLang = peerLangOf(match, side);
    await ctx.api.sendMessage(
      Number(peerTelegramId),
      t(peerLang, "matchBothAccepted"),
      ...(effectId ? [{ message_effect_id: effectId }] : []),
    );
    await startScheduling(ctx.api, match.id);
    return;
  }

  // Peer had already declined → mixed verdict. Cancel the match and
  // reveal the peer's earlier decline to the actor (who's now committed).
  // The first decider already saw `matchDeclined` so we tell them via
  // a follow-up reveal too.
  if (peerPrior === false) {
    await prisma.match.updateMany({
      where: { id: match.id, status: "proposed" },
      data: { status: "cancelled" },
    });
    // Elo: actor accepted, peer declined earlier. Use the existing
    // `updateEloScores` semantics — accepted=true, declined=false.
    const aDecision: boolean = side === "A" ? true : false;
    const bDecision: boolean = side === "B" ? true : false;
    await updateEloScores(match.userAId, match.userBId, aDecision, bDecision);
    await ctx.reply(t(lang, "matchAccepted"), {
      ...(effectId ? { message_effect_id: effectId } : {}),
    });
    await sendActorReveal(ctx, peerPrior, lang);
    await sendPeerOutcomeReveal(ctx, match, side, true);
    return;
  }

  // Peer hasn't decided yet → first-decider path. Stay in `proposed`,
  // ack the actor, fire the blind nudge to the peer.
  await ctx.reply(t(lang, "matchAccepted"), {
    ...(effectId ? { message_effect_id: effectId } : {}),
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
  const peerPrior = peerPriorAccepted(match, side);

  // Two phases:
  //   - First decider: write own `accepted{A|B} = false` but KEEP status
  //     `proposed` so the peer's keyboard stays live.
  //   - Second decider: write own decline AND flip status to `cancelled`
  //     atomically. We need to know peer's decision to update Elo.
  if (peerPrior === null) {
    await prisma.match.update({
      where: { id: match.id },
      data: side === "A" ? { acceptedByA: false } : { acceptedByB: false },
    });
  } else {
    await prisma.match.update({
      where: { id: match.id },
      data:
        side === "A"
          ? { acceptedByA: false, status: "cancelled" }
          : { acceptedByB: false, status: "cancelled" },
    });
  }

  await createMatchEvent({
    matchId: match.id,
    actorId,
    targetId,
    actionType: "DECLINED",
  });

  // Elo: actor's verdict is locked in (false). Peer's prior verdict is
  // either null (first decider — Elo update deferred to expiry job) or
  // a concrete true/false. We only update Elo when both sides have
  // committed — same rule as the legacy code, just centralised here.
  if (peerPrior !== null) {
    const aDecision: boolean = side === "A" ? false : peerPrior;
    const bDecision: boolean = side === "B" ? false : peerPrior;
    await updateEloScores(match.userAId, match.userBId, aDecision, bDecision);
  }

  await ctx.reply(t(lang, "matchDeclined"), { parse_mode: "Markdown" });

  if (peerPrior === null) {
    // Blind nudge — peer doesn't yet know which way the actor went.
    await sendPeerDecidedNudge(ctx, match, side);
    return;
  }

  // Both have now decided → reveal both ways.
  await sendActorReveal(ctx, peerPrior, lang);
  await sendPeerOutcomeReveal(ctx, match, side, false);
}
