import { prisma } from "@gennety/db";
import { t, type Language, PROXY_MAX_MESSAGE_LEN } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  resolveCoordRecipients,
  buildChatControlsKeyboard,
  type CoordMethod,
} from "../../services/coordination.js";
import {
  proxyChatSendRefusal,
  relayProxyMessage,
  type ProxyChatRefusal,
} from "../../services/proxy-chat.js";
import { telegramReachable } from "../../services/telegram-reach.js";
import { InlineKeyboard } from "grammy";
import {
  sendCoordCard,
  type SendCoordCardOptions,
} from "../../services/coordination-card/send.js";
import type {
  CoordCardInput,
  CoordCardTheme,
} from "../../services/coordination-card/index.js";

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
 * state. Whether that chat is open, what gets logged and how the partner is
 * reached all belong to `services/proxy-chat.ts`, shared with the app; this
 * file keeps only Telegram's idiom of entering and leaving a chat session.
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
  userAId: string;
  userBId: string;
  userA: CoordUser;
  userB: CoordUser;
}

interface CoordUser {
  id: string;
  telegramId: bigint;
  /**
   * Load-bearing, and it was missing.
   *
   * `resolveCoordRecipients` decides who can be offered the contact-exchange
   * fork by `telegramReachable`, whose whole point is that `telegramId > 0` is
   * not the test — a Telegram-login account carries a real positive id and no
   * bot chat. With `platform` absent from the select the predicate read
   * `undefined`, fell back to "assume Telegram", and the offer went to someone
   * who can never see it. That module's own header cites this file as the place
   * that learned the lesson in §4.5; the `select` had never caught up.
   */
  platform: string | null;
  language: string | null;
  theme: string | null;
  firstName: string | null;
  gender: string | null;
  telegramUsername: string | null;
  profile: { photos: string[] } | null;
}

const coordUserSelect = {
  id: true,
  telegramId: true,
  platform: true,
  language: true,
  // Card chrome follows the RECIPIENT's theme, and the first profile photo is
  // what fills the card's polaroid — both only exist for the coordination
  // cards (PRODUCT_SPEC §Phase 4).
  theme: true,
  firstName: true,
  gender: true,
  telegramUsername: true,
  profile: { select: { photos: true } },
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

function themeOf(u: CoordUser): CoordCardTheme {
  return (u.theme ?? "dark") as CoordCardTheme;
}

/** First profile photo — the face in the card's polaroid frame. */
function photoOf(u: CoordUser): string | null {
  return u.profile?.photos?.[0] ?? null;
}

/**
 * A coordination card, sent only to someone the bot can actually message.
 *
 * `sendCoordCard` filters on `telegramId > 0n`, and a Telegram-login app
 * account passes that with a REAL id and no bot chat. What comes back is a 403,
 * and a 403 is not merely a lost card: it is how "this person blocked the bot"
 * is detected, and that verdict takes someone out of matching.
 *
 * No push leg, on purpose. The cards sent from this file carry the two
 * contact-exchange variants, which only ever run for a pair whose BOTH sides
 * are Telegram-reachable and neither is on the app: `resolveCoordRecipients`
 * refuses any other pair at tap time, and `sendOffers` moves a pair with the
 * app in it straight onto the anonymous chat. Nothing turns a Telegram account
 * into an app-only one (linking only ever widens it to `both`), so this guards
 * an invariant rather than a branch that runs.
 */
async function sendCardIfReachable(
  ctx: BotContext,
  to: CoordUser,
  card: CoordCardInput,
  text: string,
  opts?: SendCoordCardOptions,
): Promise<void> {
  if (!telegramReachable(to)) return;
  await sendCoordCard(ctx.api, to.telegramId, card, text, opts);
}

/**
 * Take a refused user out of the chat state and say why — one exit for the
 * Enter button and the relay, so a refusal reads the same from either.
 *
 * The session is reset only when it IS the chat: a stale Enter button tapped
 * mid-way through some other flow must not knock that flow over.
 *
 * A date that is no longer `scheduled` gets its own line rather than the
 * window-close one. "Hope the date went well" is the wrong thing to tell
 * someone whose date was just cancelled, and the line has to stay neutral
 * enough that it never tells a blocked person they were blocked.
 */
async function refuseProxyChat(ctx: BotContext, refusal: ProxyChatRefusal): Promise<void> {
  if (ctx.session.matchFlow === "coordination_chat") {
    ctx.session.matchFlow = "idle";
    ctx.session.activeMatchId = null;
  }
  // A stranger's tap, or a match that no longer exists, is answered with
  // nothing — as it always was.
  if (refusal === "not-found" || refusal === "forbidden") return;
  const key = refusal === "closed" ? "coordProxyClosed" : "coordProxyUnavailable";
  await ctx.reply(t(ctx.session.language, key));
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
  const initiator = callerId === match.userA.id ? match.userA : match.userB;
  const partner = callerId === match.userA.id ? match.userB : match.userA;
  const now = new Date();

  // A contact variant whose link cannot exist is refused BEFORE anything is
  // written, so an impossible tap never locks the method (the button shouldn't
  // have shown).
  if (method === "share_self" && !initiator.telegramUsername) return;
  if (method === "request_partner" && !partner.telegramUsername) return;

  // First tap wins, and the WRITE decides it, not the read above. A same-sex
  // pair both hold the offer, so two taps can land together having both read
  // `coordMethod: null`; with a plain update the second overwrote the first's
  // choice after the first's card had already gone out, leaving the row saying
  // one thing and the partner's chat another. A and C are settled by the tap;
  // B stays open until the partner answers.
  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: "scheduled", coordMethod: null },
    data: {
      coordInitiatorId: callerId,
      coordMethod: method,
      coordChosenAt: now,
      ...(method === "request_partner" ? { coordPartnerConsent: null } : { coordResolvedAt: now }),
    },
  });
  if (claim.count === 0) {
    await ctx.reply(t(lang, "coordAlreadyChosen"));
    return;
  }

  if (method === "share_self" && initiator.telegramUsername) {
    const partnerLang = langOf(partner);
    await sendCardIfReachable(
      ctx,
      partner,
      {
        variant: "shared",
        personName: initiator.firstName ?? "",
        personPhotoRef: photoOf(initiator),
        language: partnerLang,
        theme: themeOf(partner),
      },
      t(partnerLang, "coordSharedToPartner", {
        name: initiator.firstName ?? "",
        link: telegramLink(initiator.telegramUsername),
      }),
    );
    await ctx.reply(t(lang, "coordSharedAck"));
    return;
  }

  if (method === "request_partner") {
    const partnerLang = langOf(partner);
    const kb = new InlineKeyboard()
      .text(t(partnerLang, "coordPartnerBtnApprove"), `coord:approve:${matchId}`)
      .success()
      .text(t(partnerLang, "coordPartnerBtnDecline"), `coord:decline:${matchId}`)
      .danger();
    await sendCardIfReachable(
      ctx,
      partner,
      {
        variant: "ask",
        // The face in the frame is whoever is ASKING, so the partner sees who
        // wants their contact before deciding.
        personName: initiator.firstName ?? "",
        personPhotoRef: photoOf(initiator),
        language: partnerLang,
        theme: themeOf(partner),
      },
      t(partnerLang, "coordPartnerAskApprove", { name: initiator.firstName ?? "" }),
      { keyboard: kb },
    );
    await ctx.reply(t(lang, "coordRequestAck"));
    return;
  }

  // method === "proxy" (Variant C) — locked in by the claim; the cron opens it
  // at T-1h unconditionally (no partner consent).
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

  // The answer is taken once, by the write: an approve and a decline tapped in
  // quick succession both read `coordPartnerConsent: null` above, and the
  // second used to overwrite the first after its card had gone out. The
  // method is in the guard too, because `openProxies` may have moved an
  // unanswered request onto the anonymous chat in between.
  const unanswered = {
    id: matchId,
    status: "scheduled",
    coordMethod: "request_partner",
    coordPartnerConsent: null,
  } as const;

  if (!approve) {
    // Declining to share a contact is not declining to meet: the pair still
    // has to find each other at the venue, and the card below tells the
    // initiator the anonymous chat opens about an hour before. So the decline
    // IS the switch to it. It used to record the refusal and leave the method
    // on `request_partner` — and `openProxies` opens a window only for
    // `proxy`, so the chat the card promised never came.
    const declined = await prisma.match.updateMany({
      where: unanswered,
      data: { coordPartnerConsent: false, coordMethod: "proxy", coordResolvedAt: new Date() },
    });
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (declined.count === 0) {
      await ctx.reply(t(lang, "coordAlreadyChosen"));
      return;
    }
    await sendCardIfReachable(
      ctx,
      initiator,
      {
        // No face here on purpose: the card is about the decision, not the
        // person who made it. The clock points at the anonymous chat instead,
        // which the caption spells out.
        variant: "declined",
        personName: partner.firstName ?? "",
        language: langOf(initiator),
        theme: themeOf(initiator),
      },
      t(langOf(initiator), "coordPartnerDeclined"),
    );
    return;
  }

  if (!partner.telegramUsername) return; // can't reveal without a handle

  const approved = await prisma.match.updateMany({
    where: unanswered,
    data: { coordPartnerConsent: true, coordResolvedAt: new Date() },
  });
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (approved.count === 0) {
    await ctx.reply(t(lang, "coordAlreadyChosen"));
    return;
  }
  await sendCardIfReachable(
    ctx,
    initiator,
    {
      variant: "shared",
      personName: partner.firstName ?? "",
      personPhotoRef: photoOf(partner),
      language: langOf(initiator),
      theme: themeOf(initiator),
    },
    t(langOf(initiator), "coordRevealToInitiator", {
      name: partner.firstName ?? "",
      link: telegramLink(partner.telegramUsername),
    }),
  );
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

  // The gate the relay itself will ask, so the button cannot let someone into
  // a chat whose first message would be refused — nor into a cancelled or
  // blocked date's chat, which the window alone used to allow.
  const refusal = await proxyChatSendRefusal({ matchId, userId: callerId });
  if (refusal) {
    await refuseProxyChat(ctx, refusal);
    return;
  }

  const lang = ctx.session.language;
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
 * match. Text-only — media is rejected to close the face/metadata-leak bypass.
 *
 * The gate, the log and the delivery are `relayProxyMessage`'s, the same call
 * the app's `POST /v1/matches/{id}/chat` makes. This leg used to carry its own
 * copy of all three, and each copy had drifted: its gate looked only at the
 * window, so a date cancelled, frozen or blocked inside the last hour kept
 * relaying; its delivery DM'd whatever carried a positive Telegram id, so an
 * app-only partner got a 403 instead of the push the app path sends; and its
 * rows never earned a delivery stamp.
 *
 * Re-asked per message, which is what lets a stale session self-heal: the
 * close tick cannot reset another user's session.
 */
export async function handleProxyRelay(ctx: BotContext): Promise<void> {
  const matchId = ctx.session.activeMatchId;

  if (!matchId) {
    ctx.session.matchFlow = "idle";
    return;
  }

  const callerId = await callerUserId(ctx);
  if (!callerId) {
    ctx.session.matchFlow = "idle";
    ctx.session.activeMatchId = null;
    return;
  }

  const message = ctx.message;
  const body = message?.text;
  if (!message || !body) {
    // Nothing to relay, but the chat is still asked whether it is open: a photo
    // sent into a closed or cancelled chat must end the session just as text
    // would, rather than earn a "text only" hint for a chat that is gone.
    const refusal = await proxyChatSendRefusal({ matchId, userId: callerId });
    if (refusal) {
      await refuseProxyChat(ctx, refusal);
      return;
    }
    await ctx.reply(t(ctx.session.language, "coordProxyTextOnly"));
    return;
  }

  const relayed = await relayProxyMessage({
    matchId,
    senderUserId: callerId,
    // Clamped, as this rail always has, rather than refused like the app's
    // composer: Telegram shows the writer no counter to keep under.
    body: body.slice(0, PROXY_MAX_MESSAGE_LEN),
    // This line AS ITS AUTHOR SEES IT, in their own chat with the bot — where a
    // partner's reaction has to land (see `relayProxyMessage`).
    authorChatMessageId: BigInt(message.message_id),
  });
  if (relayed.ok) return;

  // Whitespace only (the clamp rules out too-long): nothing to pass on, and
  // nothing wrong with the chat, so the session stays where it is.
  if (relayed.error === "empty" || relayed.error === "too-long") return;
  await refuseProxyChat(ctx, relayed.error);
}
