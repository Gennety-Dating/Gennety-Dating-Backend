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
  | "too-long";

export interface ProxyChatMessageView {
  id: string;
  mine: boolean;
  body: string;
  sentAt: Date;
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
 * them makes the window open up to two minutes late — on a 30-minute window
 * whose whole job is the last half hour before a meeting. Deriving it makes
 * both surfaces agree instantly and removes a dependency on cron timing for
 * something the schedule already determines. The stamps keep their real job:
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
    select: { id: true, senderId: true, body: true, createdAt: true },
  });

  return {
    open: proxyChatIsOpen(match, now),
    opensAt: window?.opensAt ?? null,
    closesAt: window?.closesAt ?? null,
    // Fetched newest-first so the cap keeps the RECENT end of a long window,
    // then reversed: the screen renders oldest to newest.
    messages: rows.reverse().map((row) => ({
      id: row.id,
      mine: row.senderId === callerId,
      body: row.body,
      sentAt: row.createdAt,
    })),
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
  return { ok: true, view: await buildView(match, input.userId, input.since, now) };
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

  await prisma.proxyMessage.create({
    data: { matchId: match.id, senderId: input.senderUserId, body },
  });

  const { me, partner } = sidesOf(match, input.senderUserId);
  // Best-effort by rule: an unreachable partner must not fail the sender's
  // send. The message is logged and on their screen the next time they open
  // the chat, which is the one delivery path that cannot break.
  await deliverToPartner(me, partner, match.id, body).catch((err) =>
    console.warn(`[proxy-chat] delivery failed for match ${match.id}:`, err),
  );

  return { ok: true, view: await buildView(match, input.senderUserId, undefined, now) };
}

type Side = ProxyMatch["userA"];

/**
 * Deliver on the partner's OWN rail — a Telegram DM, an APNs push, or both for
 * a `both`-platform account. Before this the relay only ever DM'd, so a mobile
 * partner learned of a message by opening the app, on the one screen whose
 * entire value is the thirty minutes before a meeting.
 */
async function deliverToPartner(
  sender: Side,
  partner: Side,
  matchId: string,
  body: string,
): Promise<void> {
  const lang = (partner.language ?? "en") as Language;
  const senderName = sender.firstName?.trim();
  const prefix = senderName
    ? t(lang, "coordProxyRelayNamedPrefix", { name: senderName })
    : t(lang, "coordProxyRelayPrefix");

  const jobs: Promise<unknown>[] = [];

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
        },
      ),
    );
  }

  // The push CARRIES the message text, unlike the emergency-cancellation push
  // (§4.4), which deliberately withholds the partner's free text. The two are
  // not the same case: a cancellation reason is unbidden and emotionally
  // loaded, while this is a chat the user opted into, in the last half hour
  // before meeting, where "you have a new message" is exactly the notification
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

  await Promise.all(jobs);
}
