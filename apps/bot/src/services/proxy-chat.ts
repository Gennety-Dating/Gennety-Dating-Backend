import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  PROXY_MAX_MESSAGE_LEN,
  PROXY_OPEN_HOURS,
  PROXY_CLOSE_AFTER_HOURS,
} from "@gennety/shared";
import { env } from "../config.js";
import { getMainBotApi } from "./main-bot-api.js";
import { sendPushToUser } from "./push.js";
import { withRedactedSummary } from "./outbound-recorder.js";
import { buildChatControlsKeyboard } from "./coordination.js";
import { reactToMessage, type EmojiReaction } from "./message-reactions.js";

/**
 * Anonymous pre-date proxy chat — the mechanics, shared by both surfaces
 * (PRODUCT_SPEC §Phase 4, Variant C).
 *
 * This is the same split that `emergency-cancel.ts` settled on: everything
 * that decides WHETHER a message may be relayed, writes it, and delivers it
 * lives here, so the Telegram relay and `POST /v1/matches/{id}/chat` cannot
 * disagree about the window, the log, or what the partner receives. Each
 * surface keeps only its own idiom — Telegram owns entering/leaving a chat
 * session, the app owns a screen.
 *
 * The carve-out to NO IN-APP CHAT is narrow ON PURPOSE and every narrowing
 * lives in this file: post-match only, time-boxed, text-only, every message
 * logged to `proxy_messages`. It exists to solve "find each other at the
 * venue", not conversation.
 */

/** How many messages a single read returns. */
export const PROXY_CHAT_PAGE_MAX = 200;

export type ProxyChatRefusal =
  | "disabled"
  | "not-found"
  | "forbidden"
  | "wrong-state"
  | "closed"
  | "empty"
  | "too-long"
  | "no-message"
  | "own-message"
  | "bad-reaction";

/**
 * The five emoji a person may put on their partner's message.
 *
 * **Closed set, and closed for two reasons that both bite.** Telegram accepts
 * reactions only from its own fixed list, so a free-form emoji would work
 * app-to-app and then silently do nothing on the rail most pairs actually have
 * — `setMessageReaction` refuses everything else. And the product forbids
 * like/dislike as a rating mechanic; an open keyboard lets 👎 back in through
 * the side door, on the one screen where the other party is a person about to
 * walk through the door.
 *
 * Written TELEGRAM-canonical: `❤` carries NO variation selector, because that
 * is the exact string Telegram's list holds. Appending U+FE0F here would break
 * `setMessageReaction` for the reaction the product cares about most.
 *
 * Chosen for what this screen is — the half hour before meeting, where the
 * traffic is "on my way", "found it, thanks", "waiting": warmth, acknowledge,
 * enthusiasm, laughter, thanks. 😂 is deliberately absent: Telegram's list
 * carries 🤣 and not 😂, and an emoji that works on one rail only is worse
 * than one fewer.
 */
export const PROXY_REACTIONS = ["❤", "👍", "🔥", "🤣", "🙏"] as const;
export type ProxyReaction = (typeof PROXY_REACTIONS)[number];

export function isProxyReaction(value: string): value is ProxyReaction {
  return (PROXY_REACTIONS as readonly string[]).includes(value);
}

/**
 * How far one's OWN message got. Present on `mine` rows only — the states are
 * what the sender is told about their own reply, and a status on the partner's
 * message would be telling them about themselves.
 *
 * Computed here rather than shipped as raw timestamps for the reason the whole
 * module exists: two surfaces deriving "read" from two columns would sooner or
 * later derive it differently, and this is a claim about another person.
 */
export type ProxyChatDeliveryStatus = "sent" | "delivered" | "read";

export interface ProxyChatMessageView {
  id: string;
  mine: boolean;
  body: string;
  sentAt: Date;
  /** Undefined on the partner's messages. */
  status?: ProxyChatDeliveryStatus;
  /**
   * The emoji sitting on this message, from either side. Undefined when there
   * is none.
   *
   * Unlike `status` this is NOT scoped to `mine`, and the asymmetry is the
   * point: a delivery state is something the sender is told about their own
   * message, while a reaction is a thing the other person did — visible to
   * both, on whichever bubble carries it.
   */
  reaction?: string;
}

export interface ProxyChatView {
  open: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  messages: ProxyChatMessageView[];
  maxMessageLength: number;
  partnerFirstName: string | null;
  serverNow: Date;
}

export type ProxyChatResult =
  | { ok: true; view: ProxyChatView }
  | { ok: false; error: ProxyChatRefusal };

const matchSelect = {
  id: true,
  status: true,
  userAId: true,
  userBId: true,
  agreedTime: true,
  coordMethod: true,
  proxyClosedAt: true,
  proxyReadAtA: true,
  proxyReadAtB: true,
  userA: { select: { id: true, telegramId: true, platform: true, language: true, firstName: true } },
  userB: { select: { id: true, telegramId: true, platform: true, language: true, firstName: true } },
} as const;

type ProxyMatch = NonNullable<Awaited<ReturnType<typeof loadMatch>>>;

function loadMatch(matchId: string) {
  return prisma.match.findUnique({ where: { id: matchId }, select: matchSelect });
}

/**
 * The window, derived from `agreedTime` rather than read from
 * `proxyOpenedAt`/`proxyClosesAt`.
 *
 * Those columns are written by the 2-minute coordination tick, so gating on
 * them makes the window open up to two minutes late — on a window whose whole
 * job is the last hour before a meeting. Deriving it makes both surfaces agree
 * instantly and removes a dependency on cron timing for something the schedule
 * already determines. The stamps keep their real job:
 * `proxyOpenedAt` records that both sides were TOLD, and `proxyClosedAt` is a
 * force-close that still wins here.
 *
 * Returns null when this pair has no window at all — the coordination method
 * is not the proxy variant, or the date has no agreed time.
 */
export function proxyChatWindow(match: {
  agreedTime: Date | null;
  coordMethod: string | null;
}): { opensAt: Date; closesAt: Date } | null {
  if (match.coordMethod !== "proxy" || !match.agreedTime) return null;
  const at = match.agreedTime.getTime();
  return {
    opensAt: new Date(at - PROXY_OPEN_HOURS * 60 * 60 * 1000),
    closesAt: new Date(at + PROXY_CLOSE_AFTER_HOURS * 60 * 60 * 1000),
  };
}

/** Whether a message may be relayed right now. */
export function proxyChatIsOpen(
  match: { agreedTime: Date | null; coordMethod: string | null; proxyClosedAt: Date | null },
  now: Date,
): boolean {
  if (match.proxyClosedAt) return false;
  const window = proxyChatWindow(match);
  if (!window) return false;
  return now >= window.opensAt && now < window.closesAt;
}

function sidesOf(match: ProxyMatch, callerId: string) {
  const me = callerId === match.userAId ? match.userA : match.userB;
  const partner = callerId === match.userAId ? match.userB : match.userA;
  return { me, partner };
}

/** How far the PARTNER of `callerId` has read. Null = never opened the screen. */
function partnerReadAt(match: ProxyMatch, callerId: string): Date | null {
  return callerId === match.userAId ? match.proxyReadAtB : match.proxyReadAtA;
}

/**
 * The sender's own three states, from three facts the server actually holds.
 *
 * Nothing here is inferred from timing or from the shape of the conversation:
 * "sent" is a row, "delivered" is a rail that accepted it, "read" is a cursor a
 * person moved by opening the screen. A fourth state is not missing — a failed
 * send never becomes a row at all, so the client has an error to show and no
 * status to draw.
 */
function deliveryStatus(
  row: { createdAt: Date; deliveredAt: Date | null },
  readAt: Date | null,
): ProxyChatDeliveryStatus {
  if (readAt && readAt >= row.createdAt) return "read";
  return row.deliveredAt ? "delivered" : "sent";
}

async function buildView(
  match: ProxyMatch,
  callerId: string,
  since: string | undefined,
  now: Date,
): Promise<ProxyChatView> {
  const window = proxyChatWindow(match);
  const { partner } = sidesOf(match, callerId);

  // An unknown cursor returns the whole window rather than nothing: a client
  // holding an id this match does not carry would otherwise be stuck with a
  // cursor it can never advance past.
  let after: Date | null = null;
  if (since) {
    const anchor = await prisma.proxyMessage.findFirst({
      where: { id: since, matchId: match.id },
      select: { createdAt: true },
    });
    after = anchor?.createdAt ?? null;
  }

  const rows = await prisma.proxyMessage.findMany({
    where: { matchId: match.id, ...(after ? { createdAt: { gt: after } } : {}) },
    orderBy: { createdAt: "desc" },
    take: PROXY_CHAT_PAGE_MAX,
    select: {
      id: true,
      senderId: true,
      body: true,
      createdAt: true,
      deliveredAt: true,
      reaction: true,
    },
  });

  const readAt = partnerReadAt(match, callerId);

  return {
    open: proxyChatIsOpen(match, now),
    opensAt: window?.opensAt ?? null,
    closesAt: window?.closesAt ?? null,
    // Fetched newest-first so the cap keeps the RECENT end of a long window,
    // then reversed: the screen renders oldest to newest.
    messages: rows.reverse().map((row) => {
      const mine = row.senderId === callerId;
      return {
        id: row.id,
        mine,
        body: row.body,
        sentAt: row.createdAt,
        ...(mine ? { status: deliveryStatus(row, readAt) } : {}),
        ...(row.reaction ? { reaction: row.reaction } : {}),
      };
    }),
    maxMessageLength: PROXY_MAX_MESSAGE_LEN,
    partnerFirstName: partner.firstName,
    serverNow: now,
  };
}

/**
 * Read the window and its messages.
 *
 * Deliberately succeeds while the window is shut: the client has to render
 * "the chat opens at 19:30" before it opens and "the chat has closed" after,
 * and a refusal there leaves it with nothing to say. Only sending is gated.
 *
 * **Reading here is what moves the caller's read cursor**, and the honesty of
 * the partner's "read" tick rests entirely on that: this endpoint is called by
 * the app, and the app calls it only while its chat screen is on the phone. A
 * background refresh or a prefetch would turn the cursor into a lie, so if one
 * is ever added it must not come through this function.
 */
export async function readProxyChat(input: {
  matchId: string;
  userId: string;
  since?: string;
  now?: Date;
}): Promise<ProxyChatResult> {
  if (!env.COORDINATION_FEATURE_ENABLED) return { ok: false, error: "disabled" };

  const match = await loadMatch(input.matchId);
  if (!match) return { ok: false, error: "not-found" };
  if (input.userId !== match.userAId && input.userId !== match.userBId) {
    return { ok: false, error: "forbidden" };
  }
  if (match.status !== "scheduled") return { ok: false, error: "wrong-state" };

  const now = input.now ?? new Date();
  const view = await buildView(match, input.userId, input.since, now);
  await markRead(match, input.userId, now);
  return { ok: true, view };
}

/**
 * Advance the caller's read cursor — but only when something of the partner's
 * is actually sitting above it.
 *
 * The guard is not micro-optimisation: the app polls this every four seconds
 * for up to three hours, and a cursor that rewrites itself on every poll would
 * be ~2700 pointless UPDATEs per open chat, on the one table the moderation
 * trail depends on.
 */
async function markRead(match: ProxyMatch, callerId: string, now: Date): Promise<void> {
  const mine = callerId === match.userAId;
  const current = mine ? match.proxyReadAtA : match.proxyReadAtB;

  const unread = await prisma.proxyMessage.findFirst({
    where: {
      matchId: match.id,
      senderId: { not: callerId },
      ...(current ? { createdAt: { gt: current } } : {}),
    },
    select: { id: true },
  });
  if (!unread) return;

  await prisma.match.update({
    where: { id: match.id },
    data: mine ? { proxyReadAtA: now } : { proxyReadAtB: now },
  });
}

/**
 * Log and relay one message. The write happens BEFORE delivery: the moderation
 * log is what justifies this feature existing at all, so a delivery failure
 * must not be able to produce an unlogged message.
 */
export async function relayProxyMessage(input: {
  matchId: string;
  senderUserId: string;
  body: string;
  now?: Date;
}): Promise<ProxyChatResult> {
  if (!env.COORDINATION_FEATURE_ENABLED) return { ok: false, error: "disabled" };

  const body = input.body.trim();
  if (!body) return { ok: false, error: "empty" };
  if (body.length > PROXY_MAX_MESSAGE_LEN) return { ok: false, error: "too-long" };

  const match = await loadMatch(input.matchId);
  if (!match) return { ok: false, error: "not-found" };
  if (input.senderUserId !== match.userAId && input.senderUserId !== match.userBId) {
    return { ok: false, error: "forbidden" };
  }
  if (match.status !== "scheduled") return { ok: false, error: "wrong-state" };

  const now = input.now ?? new Date();
  if (!proxyChatIsOpen(match, now)) return { ok: false, error: "closed" };

  const message = await prisma.proxyMessage.create({
    data: { matchId: match.id, senderId: input.senderUserId, body },
    select: { id: true },
  });

  const { me, partner } = sidesOf(match, input.senderUserId);
  // Best-effort by rule: an unreachable partner must not fail the sender's
  // send. The message is logged and on their screen the next time they open
  // the chat, which is the one delivery path that cannot break.
  const delivered = await deliverToPartner(me, partner, match.id, body).catch((err) => {
    console.warn(`[proxy-chat] delivery failed for match ${match.id}:`, err);
    return false;
  });

  // Stamped only on a rail that ACCEPTED it. An unreachable partner leaves this
  // null and the sender sees one tick — which is the truth, and which repairs
  // itself the moment they open the chat: reading sets their cursor, and "read"
  // outranks "delivered" without needing this stamp at all.
  if (delivered) {
    await prisma.proxyMessage.update({
      where: { id: message.id },
      data: { deliveredAt: now },
    });
  }

  return { ok: true, view: await buildView(match, input.senderUserId, undefined, now) };
}

/**
 * Put one emoji on the PARTNER's message, or take it off again.
 *
 * **Why a write and not a client-side flourish.** The same reason the delivery
 * ticks stopped being a client guess (DECISIONS 2026-09-07): a reaction the
 * other person never sees is decoration, and most pairs here are one app plus
 * one Telegram. The row is the fact; both rails read it from the same place.
 *
 * **You cannot react to your own message.** Not a nicety — a reaction is
 * something the reader does, and self-reacting would show the author a mark
 * they made themselves, on the one screen built to say "I'm here, are you".
 * The app hides the gesture on `mine`; this refuses it, because a hidden
 * gesture is not a rule.
 *
 * **Passing null clears it.** Pressing the emoji already on the message is an
 * un-react in every chat app anyone has used, and the client sends null for it
 * rather than a second "reaction" value the storage would have to interpret.
 *
 * **The window does NOT gate this.** Sending is time-boxed because the chat
 * exists to find each other; reacting to a line already said costs nobody
 * anything, and refusing it after the window would leave the last "I'm
 * outside" hanging with no way to answer while the pair is literally meeting.
 * Reading is ungated for the same reason.
 */
export async function reactToProxyMessage(input: {
  matchId: string;
  messageId: string;
  userId: string;
  /** One of `PROXY_REACTIONS`, or null to remove the current one. */
  reaction: string | null;
  now?: Date;
}): Promise<ProxyChatResult> {
  if (!env.COORDINATION_FEATURE_ENABLED) return { ok: false, error: "disabled" };

  if (input.reaction !== null && !isProxyReaction(input.reaction)) {
    return { ok: false, error: "bad-reaction" };
  }

  const match = await loadMatch(input.matchId);
  if (!match) return { ok: false, error: "not-found" };
  if (input.userId !== match.userAId && input.userId !== match.userBId) {
    return { ok: false, error: "forbidden" };
  }
  if (match.status !== "scheduled") return { ok: false, error: "wrong-state" };

  // Scoped to the match, not just the id: a message id from ANOTHER match
  // would otherwise be reactable by anyone who could guess it.
  const message = await prisma.proxyMessage.findFirst({
    where: { id: input.messageId, matchId: match.id },
    select: { id: true, senderId: true, authorChatMessageId: true },
  });
  if (!message) return { ok: false, error: "no-message" };
  if (message.senderId === input.userId) return { ok: false, error: "own-message" };

  const now = input.now ?? new Date();
  await prisma.proxyMessage.update({
    where: { id: message.id },
    data: { reaction: input.reaction },
  });

  // Best-effort onto the author's rail, exactly like delivery: a Telegram hiccup
  // must not fail the tap. The row is already written, so the author sees it the
  // next time they open the app either way.
  await deliverReactionToAuthor(match, message.senderId, message.authorChatMessageId, input.reaction);

  return { ok: true, view: await buildView(match, input.userId, undefined, now) };
}

/**
 * Show the reaction to the person who wrote the line.
 *
 * Nothing happens for an app author: they have no Telegram copy of their own
 * message, and their screen polls the row. Nothing happens either for a
 * Telegram author whose message predates `authorChatMessageId` — old rows
 * carry null, and a reaction on them is app-visible only. That is the whole
 * migration story, and it decays on its own within one chat window.
 */
async function deliverReactionToAuthor(
  match: ProxyMatch,
  authorId: string,
  authorChatMessageId: bigint | null,
  reaction: string | null,
): Promise<void> {
  if (authorChatMessageId === null) return;

  const author = authorId === match.userAId ? match.userA : match.userB;
  const reachable =
    author.telegramId > 0n && (author.platform === "telegram" || author.platform === "both");
  if (!reachable) return;

  const api = getMainBotApi();
  if (!api) return;

  // `reactToMessage` swallows its own failures; an empty list is how Telegram
  // spells "remove", which is why clearing takes the same path as setting.
  await reactToMessage(
    api,
    { chatId: Number(author.telegramId), messageId: Number(authorChatMessageId) },
    reaction as EmojiReaction | null,
  );
}

type Side = ProxyMatch["userA"];

/**
 * Deliver on the partner's OWN rail — a Telegram DM, an APNs push, or both for
 * a `both`-platform account. Before this the relay only ever DM'd, so a mobile
 * partner learned of a message by opening the app, on the one screen whose
 * entire value is the hour before a meeting.
 *
 * Returns whether ANY rail accepted it, which is what the sender's second tick
 * means. `allSettled` rather than `all` for exactly that reason: a `both`
 * partner whose DM fails but whose push lands HAS been reached, and reporting
 * the first rejection would call that a failure.
 */
async function deliverToPartner(
  sender: Side,
  partner: Side,
  matchId: string,
  body: string,
): Promise<boolean> {
  const lang = (partner.language ?? "en") as Language;
  const senderName = sender.firstName?.trim();
  const prefix = senderName
    ? t(lang, "coordProxyRelayNamedPrefix", { name: senderName })
    : t(lang, "coordProxyRelayPrefix");

  const jobs: Promise<boolean>[] = [];

  const api = getMainBotApi();
  const telegramReachable =
    partner.telegramId > 0n && (partner.platform === "telegram" || partner.platform === "both");
  if (api && telegramReachable) {
    // Relayed text is written by the OTHER user, and the recipient's chat
    // timeline feeds their menu agent's prompt, which holds profile-writing
    // tools. The timeline records only THAT a message arrived; `proxy_messages`
    // stays the full log.
    jobs.push(
      withRedactedSummary(
        "(relayed message from the date partner in the anonymous coordination chat)",
        async () => {
          await api.sendMessage(Number(partner.telegramId), `${prefix}${body}`, {
            reply_markup: buildChatControlsKeyboard(matchId, lang),
          });
          return true;
        },
      ),
    );
  }

  // The push CARRIES the message text, unlike the emergency-cancellation push
  // (§4.4), which deliberately withholds the partner's free text. The two are
  // not the same case: a cancellation reason is unbidden and emotionally
  // loaded, while this is a chat the user opted into, in the last hour before
  // meeting, where "you have a new message" is exactly the notification
  // that makes someone open the app to read "I'm by the door" thirty seconds
  // too late.
  if (partner.platform === "mobile" || partner.platform === "both") {
    jobs.push(
      sendPushToUser(partner.id, {
        title: senderName ?? t(lang, "coordProxyPushTitle"),
        body,
        data: { type: "proxy.message", matchId },
      }),
    );
  }

  const results = await Promise.allSettled(jobs);
  return results.some((r) => r.status === "fulfilled" && r.value);
}
