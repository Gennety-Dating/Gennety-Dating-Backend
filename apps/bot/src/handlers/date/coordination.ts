import { prisma } from "@gennety/db";
import { t, type Language, PROXY_MAX_MESSAGE_LEN } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  resolveCoordRecipients,
  buildChatControlsKeyboard,
  isProxyOpen,
  type CoordMethod,
} from "../../services/coordination.js";
import { InlineKeyboard } from "grammy";

/**
 * Pre-date coordination handlers (PRODUCT_SPEC.md §Phase 4, feature-flagged).
 *
 * Routed inside `dateRouter` (runs before the menu LLM router, gates on
 * completed onboarding). Callback families:
 *   - `coord:m:{matchId}:{share_self|request_partner|proxy}` — initiator picks
 *   - `coord:approve|decline:{matchId}` — partner consent (Variant B ONLY)
 *   - `coord:enter:{matchId}` — join the anonymous proxy chat (Variant C)
 *   - `coord:exit` — leave the proxy chat
 * Plus the free-text relay leg for users in the `coordination_chat` session
 * state.
 *
 * The contact reveal (A/B) is a plain `t.me/<username>` link — Telegram
 * auto-linkifies it. We deliberately avoid `text_mention` (`tg://user?id=`):
 * to a stranger with no shared chat it renders as "User not found" or a dead
 * link under common privacy settings.
 */

interface CoordMatch {
  id: string;
  status: string;
  coordInitiatorId: string | null;
  coordMethod: string | null;
  coordPartnerConsent: boolean | null;
  proxyOpenedAt: Date | null;
  proxyClosesAt: Date | null;
  proxyClosedAt: Date | null;
  userAId: string;
  userBId: string;
  userA: CoordUser;
  userB: CoordUser;
}

interface CoordUser {
  id: string;
  telegramId: bigint;
  language: string | null;
  firstName: string | null;
  gender: string | null;
  telegramUsername: string | null;
}

const coordUserSelect = {
  id: true,
  telegramId: true,
  language: true,
  firstName: true,
  gender: true,
  telegramUsername: true,
} as const;

function loadCoordMatch(matchId: string): Promise<CoordMatch | null> {
  return prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      coordInitiatorId: true,
      coordMethod: true,
      coordPartnerConsent: true,
      proxyOpenedAt: true,
      proxyClosesAt: true,
      proxyClosedAt: true,
      userAId: true,
      userBId: true,
      userA: { select: coordUserSelect },
      userB: { select: coordUserSelect },
    },
  });
}

async function callerUserId(ctx: BotContext): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  return user?.id ?? null;
}

function telegramLink(username: string): string {
  return `https://t.me/${username}`;
}

function langOf(u: CoordUser): Language {
  return (u.language ?? "en") as Language;
}

async function dmCatch(
  ctx: BotContext,
  telegramId: bigint,
  text: string,
  extra?: Parameters<typeof ctx.api.sendMessage>[2],
): Promise<void> {
  if (telegramId <= 0n) return;
  await ctx.api
    .sendMessage(Number(telegramId), text, extra)
    .catch((err: unknown) =>
      console.warn(
        `[coordination] dm failed for ${telegramId}:`,
        err instanceof Error ? err.message : err,
      ),
    );
}

/** `coord:m:{matchId}:{method}` — initiator picks a coordination option. */
export async function handleCoordMethod(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("coord:m:")) return;
  await ctx.answerCallbackQuery();

  const parts = data.split(":"); // coord, m, {matchId}, {method}
  const matchId = parts[2];
  const method = parts[3] as CoordMethod;
  if (!matchId || !["share_self", "request_partner", "proxy"].includes(method)) return;

  const callerId = await callerUserId(ctx);
  if (!callerId) return;

  const match = await loadCoordMatch(matchId);
  if (!match || match.status !== "scheduled") return;

  // Only an eligible offer recipient (the female participant, or either side in
  // a same-sex pair) may pick — and only the first tapper, first-tap-wins.
  const recipients = resolveCoordRecipients(match.userA, match.userB);
  if (!recipients.some((r) => r.id === callerId)) return;

  const lang = ctx.session.language;
  if (match.coordMethod !== null) {
    await ctx.reply(t(lang, "coordAlreadyChosen"));
    return;
  }

  const initiator = callerId === match.userA.id ? match.userA : match.userB;
  const partner = callerId === match.userA.id ? match.userB : match.userA;
  const now = new Date();

  if (method === "share_self") {
    if (!initiator.telegramUsername) return; // button shouldn't have shown
    await prisma.match.update({
      where: { id: matchId },
      data: {
        coordInitiatorId: callerId,
        coordMethod: method,
        coordChosenAt: now,
        coordResolvedAt: now,
      },
    });
    const partnerLang = langOf(partner);
    await dmCatch(
      ctx,
      partner.telegramId,
      t(partnerLang, "coordSharedToPartner", {
        name: initiator.firstName ?? "",
        link: telegramLink(initiator.telegramUsername),
      }),
    );
    await ctx.reply(t(lang, "coordSharedAck"));
    return;
  }

  if (method === "request_partner") {
    if (!partner.telegramUsername) return; // button shouldn't have shown
    await prisma.match.update({
      where: { id: matchId },
      data: {
        coordInitiatorId: callerId,
        coordMethod: method,
        coordChosenAt: now,
        coordPartnerConsent: null,
      },
    });
    const partnerLang = langOf(partner);
    const kb = new InlineKeyboard()
      .text(t(partnerLang, "coordPartnerBtnApprove"), `coord:approve:${matchId}`)
      .text(t(partnerLang, "coordPartnerBtnDecline"), `coord:decline:${matchId}`);
    await dmCatch(
      ctx,
      partner.telegramId,
      t(partnerLang, "coordPartnerAskApprove", { name: initiator.firstName ?? "" }),
      { reply_markup: kb },
    );
    await ctx.reply(t(lang, "coordRequestAck"));
    return;
  }

  // method === "proxy" (Variant C) — locked in; the cron opens it at T-30m
  // unconditionally (no partner consent).
  await prisma.match.update({
    where: { id: matchId },
    data: {
      coordInitiatorId: callerId,
      coordMethod: method,
      coordChosenAt: now,
      coordResolvedAt: now,
    },
  });
  await ctx.reply(t(lang, "coordProxyChosenAck"));
}

/** `coord:approve|decline:{matchId}` — partner consent for Variant B. */
export async function handleCoordConsent(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("coord:approve:") && !data?.startsWith("coord:decline:")) return;
  await ctx.answerCallbackQuery();

  const approve = data.startsWith("coord:approve:");
  const matchId = data.slice(approve ? "coord:approve:".length : "coord:decline:".length);
  if (!matchId) return;

  const callerId = await callerUserId(ctx);
  if (!callerId) return;

  const match = await loadCoordMatch(matchId);
  if (
    !match ||
    match.status !== "scheduled" ||
    match.coordMethod !== "request_partner" ||
    match.coordPartnerConsent !== null
  ) {
    return;
  }

  // Caller must be the partner (the side that did NOT initiate).
  const isParticipant = callerId === match.userAId || callerId === match.userBId;
  if (!isParticipant || callerId === match.coordInitiatorId) return;

  const partner = callerId === match.userA.id ? match.userA : match.userB;
  const initiator = callerId === match.userA.id ? match.userB : match.userA;
  const lang = ctx.session.language;

  if (!approve) {
    await prisma.match.update({
      where: { id: matchId },
      data: { coordPartnerConsent: false, coordResolvedAt: new Date() },
    });
    await dmCatch(ctx, initiator.telegramId, t(langOf(initiator), "coordPartnerDeclined"));
    await ctx.editMessageReplyMarkup().catch(() => {});
    return;
  }

  if (!partner.telegramUsername) return; // can't reveal without a handle

  await prisma.match.update({
    where: { id: matchId },
    data: { coordPartnerConsent: true, coordResolvedAt: new Date() },
  });
  await dmCatch(
    ctx,
    initiator.telegramId,
    t(langOf(initiator), "coordRevealToInitiator", {
      name: partner.firstName ?? "",
      link: telegramLink(partner.telegramUsername),
    }),
  );
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply(t(lang, "coordSharedAck"));
}

/** `coord:enter:{matchId}` — join the anonymous proxy chat (Variant C). */
export async function handleCoordEnter(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("coord:enter:")) return;
  await ctx.answerCallbackQuery();

  const matchId = data.slice("coord:enter:".length);
  if (!matchId) return;

  const callerId = await callerUserId(ctx);
  if (!callerId) return;

  const match = await loadCoordMatch(matchId);
  if (!match) return;
  const isParticipant = callerId === match.userAId || callerId === match.userBId;
  if (!isParticipant) return;

  const lang = ctx.session.language;
  if (!isProxyOpen(match, new Date())) {
    await ctx.reply(t(lang, "coordProxyClosed"));
    return;
  }

  ctx.session.matchFlow = "coordination_chat";
  ctx.session.activeMatchId = matchId;
  await ctx.reply(t(lang, "coordChatEntered"), {
    reply_markup: buildChatControlsKeyboard(matchId, lang),
  });
}

/** `coord:exit` — leave the anonymous proxy chat. */
export async function handleCoordExit(ctx: BotContext): Promise<void> {
  if (ctx.callbackQuery?.data !== "coord:exit") return;
  await ctx.answerCallbackQuery();
  ctx.session.matchFlow = "idle";
  ctx.session.activeMatchId = null;
  await ctx.reply(t(ctx.session.language, "coordChatExited"));
}

/**
 * Free-text relay leg: forward a `coordination_chat` user's message to their
 * match through the bot. Text-only — media is rejected to close the
 * face/metadata-leak bypass. Re-checks the T+2h window per message so a stale
 * session self-heals (the close cron can't reset another user's session).
 */
export async function handleProxyRelay(ctx: BotContext): Promise<void> {
  const matchId = ctx.session.activeMatchId;
  const lang = ctx.session.language;

  if (!matchId) {
    ctx.session.matchFlow = "idle";
    return;
  }

  const callerId = await callerUserId(ctx);
  const match = callerId ? await loadCoordMatch(matchId) : null;
  if (!callerId || !match) {
    ctx.session.matchFlow = "idle";
    ctx.session.activeMatchId = null;
    return;
  }

  const isParticipant = callerId === match.userAId || callerId === match.userBId;
  if (!isParticipant) {
    ctx.session.matchFlow = "idle";
    ctx.session.activeMatchId = null;
    return;
  }

  // Window closed (or never a proxy) → drop out of the chat state and inform.
  if (match.coordMethod !== "proxy" || !isProxyOpen(match, new Date())) {
    ctx.session.matchFlow = "idle";
    ctx.session.activeMatchId = null;
    await ctx.reply(t(lang, "coordProxyClosed"));
    return;
  }

  // Text-only: reject media without leaving the chat.
  const body = ctx.message?.text;
  if (!body) {
    await ctx.reply(t(lang, "coordProxyTextOnly"));
    return;
  }

  const sender = callerId === match.userA.id ? match.userA : match.userB;
  const partner = callerId === match.userA.id ? match.userB : match.userA;
  const clamped = body.slice(0, PROXY_MAX_MESSAGE_LEN);

  await prisma.proxyMessage.create({
    data: { matchId, senderId: callerId, body: clamped },
  });

  const partnerLang = langOf(partner);
  // By this point the recipient already knows this person by name + photo from
  // the pitch and scheduling, so attribute the relayed line to the sender's
  // first name ("💬 Alena: hi") rather than the impersonal "💬 Your date:". Fall
  // back to the generic prefix only if a name is somehow missing (firstName is a
  // required onboarding field, so this is defensive). The message is sent as
  // plain text (no parse_mode), so the name needs no Markdown escaping.
  const senderName = sender.firstName?.trim();
  const prefix = senderName
    ? t(partnerLang, "coordProxyRelayNamedPrefix", { name: senderName })
    : t(partnerLang, "coordProxyRelayPrefix");
  await dmCatch(
    ctx,
    partner.telegramId,
    `${prefix}${clamped}`,
    { reply_markup: buildChatControlsKeyboard(matchId, partnerLang) },
  );
}
