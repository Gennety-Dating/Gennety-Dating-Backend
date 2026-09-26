import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  PROXY_OPEN_HOURS,
  PROXY_CLOSE_AFTER_HOURS,
} from "@gennety/shared";
import { env } from "../config.js";
import { sendCoordCard } from "./coordination-card/send.js";
import { sendPushToUser } from "./push.js";
import { advanceDateDayActivities } from "./date-day-activity.js";
import { telegramReachable } from "./telegram-reach.js";
import type { CoordCardTheme } from "./coordination-card/index.js";

/**
 * Pre-date coordination service (PRODUCT_SPEC.md §Phase 4, feature-flagged
 * behind `COORDINATION_FEATURE_ENABLED`).
 *
 * Runs on the existing date-lifecycle `setInterval` tick. Two idempotent
 * responsibilities, each gated by a DB timestamp so retries / overlapping
 * ticks never double-send:
 *
 *   1. **Open proxy (T-1h)** — open the anonymous window for EVERY scheduled
 *      date and tell both sides on their own rail (an "Enter chat" card on
 *      Telegram, a push on the app).
 *   2. **Close proxy (T+2h)** — stamp the window closed and DM both, unless
 *      the date was called off in the meantime.
 *
 * **There is no choice any more, and no contact exchange (founder decision
 * 2026-09-26).** Until then a T-3h questionnaire asked the initiator to pick
 * between handing over a Telegram handle (A), asking for the partner's (B), or
 * this chat (C), and the chat opened only for a pair that ended up on C. A
 * Telegram-only pair whose initiator picked a handle, or never tapped the
 * offer at all, had no chat in the last hour before meeting. Handles never
 * change hands now: the anonymous chat is the one rail every pair gets. The
 * `coord*` columns stay on `Match` for the rows written before the change and
 * are no longer read or written here.
 */

export interface CoordinationResult {
  opened: number;
  closed: number;
}

/** Persistent [Leave chat] [Report] controls shown on every proxy message. */
export function buildChatControlsKeyboard(matchId: string, lang: Language): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, "coordExitBtn"), "coord:exit")
    .text(t(lang, "coordReportBtn"), `report:open:${matchId}`);
}

/**
 * Whether the tick has announced a proxy window that has not yet reached its
 * stamped close. Window stamps only: it knows nothing about the match's status,
 * so it is NOT a gate on who may send — that is
 * `proxyChatAcceptsMessages` in `proxy-chat.ts`, which folds this in. Alone it
 * is fit only for deciding whether to show an Enter button, whose tap the gate
 * re-checks.
 */
export function isProxyOpen(
  match: { proxyOpenedAt: Date | null; proxyClosedAt: Date | null; proxyClosesAt: Date | null },
  now: Date,
): boolean {
  return (
    match.proxyOpenedAt !== null &&
    match.proxyClosedAt === null &&
    match.proxyClosesAt !== null &&
    now < match.proxyClosesAt
  );
}

/** Single coordination tick. Returns counts for logging / testing. */
export async function runCoordinationTick(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<CoordinationResult> {
  const result: CoordinationResult = { opened: 0, closed: 0 };
  if (!env.COORDINATION_FEATURE_ENABLED) return result;

  await openProxies(api, now, result);
  await closeProxies(api, now, result);

  return result;
}

// 1. Open proxy at T-1h, for every scheduled date ------------------------------

async function openProxies(
  api: Api<RawApi>,
  now: Date,
  result: CoordinationResult,
): Promise<void> {
  const openWindowEnd = new Date(now.getTime() + PROXY_OPEN_HOURS * 60 * 60 * 1000);

  const matches = await prisma.match.findMany({
    where: {
      status: "scheduled",
      proxyOpenedAt: null,
      agreedTime: { gt: now, lte: openWindowEnd },
    },
    select: {
      id: true,
      agreedTime: true,
      userA: { select: { id: true, telegramId: true, platform: true, language: true, theme: true } },
      userB: { select: { id: true, telegramId: true, platform: true, language: true, theme: true } },
    },
  });

  for (const match of matches) {
    const closesAt = new Date(
      match.agreedTime!.getTime() + PROXY_CLOSE_AFTER_HOURS * 60 * 60 * 1000,
    );

    // Claimed BEFORE anyone is told, by a write that only one tick can win.
    // Stamping after the sends let two overlapping ticks both read
    // `proxyOpenedAt: null` and both announce the chat — two cards, two pushes,
    // two Live Activity advances. It also re-checks the date is still on: a
    // cancellation between the read and here must not open a chat.
    const claim = await prisma.match.updateMany({
      where: { id: match.id, status: "scheduled", proxyOpenedAt: null },
      data: { proxyOpenedAt: now, proxyClosesAt: closesAt },
    });
    if (claim.count === 0) continue;

    for (const u of [match.userA, match.userB]) {
      // A mobile participant is told on their own rail. Before this the open
      // was a Telegram card and nothing else, so someone on the app got a
      // window they were never informed about — for the last hour before the
      // date, when it matters most.
      if (u.platform === "mobile" || u.platform === "both") {
        const lang = (u.language ?? "en") as Language;
        await sendPushToUser(u.id, {
          title: t(lang, "coordProxyPushTitle"),
          body: t(lang, "coordProxyOpenedEnterPrompt"),
          data: { type: "proxy.opened", matchId: match.id },
        }).catch(() => false);
      }
      if (!telegramReachable(u)) continue;
      const lang = (u.language ?? "en") as Language;
      const kb = new InlineKeyboard().text(
        t(lang, "coordEnterBtn"),
        `coord:enter:${match.id}`,
      );
      // No photo by design — the withheld portrait IS the card (PRODUCT_SPEC
      // §Phase 4), and showing a face on the anonymous-chat card would
      // contradict the thing it announces.
      await sendCoordCard(
        api,
        u.telegramId,
        {
          variant: "proxy",
          personName: "",
          language: lang,
          theme: (u.theme ?? "dark") as CoordCardTheme,
        },
        t(lang, "coordProxyOpenedEnterPrompt"),
        { keyboard: kb },
      );
    }

    // The `chat_open` stage of the date-day Live Activity (§4.2) was declared
    // on both sides and deliberately never sent, because announcing an open
    // chat on a lock screen the app could not enter is a button into nowhere.
    // The app can enter it now, so the stage finally fires.
    await advanceDateDayActivities(match.id, "chat_open").catch(() => undefined);

    result.opened++;
  }
}

// 2. Close proxy at T+2h ------------------------------------------------------

/**
 * Whose chat closing is worth a message. "Hope the date went well — I'll check
 * in tomorrow" is right for a date that is on or has happened (`completed` is
 * set by the feedback prompt, which demo's replay runs in the same beat as
 * this close) and wrong for one that was cancelled, blocked or frozen: those
 * people were already told their date is off, and the second message would
 * contradict the first. Their window is still stamped closed, silently.
 */
const CLOSE_NOTICE_STATUSES: readonly string[] = ["scheduled", "completed"];

async function closeProxies(
  api: Api<RawApi>,
  now: Date,
  result: CoordinationResult,
): Promise<void> {
  const matches = await prisma.match.findMany({
    where: {
      proxyOpenedAt: { not: null },
      proxyClosedAt: null,
      proxyClosesAt: { lte: now },
    },
    select: {
      id: true,
      status: true,
      userA: { select: { telegramId: true, platform: true, language: true } },
      userB: { select: { telegramId: true, platform: true, language: true } },
    },
  });

  for (const match of matches) {
    const notify = CLOSE_NOTICE_STATUSES.includes(match.status);
    for (const u of [match.userA, match.userB]) {
      // `telegramReachable`, not `telegramId > 0n`: a Telegram-login app account
      // carries a real id and no bot chat, and the 403 it returns is read as
      // that person blocking the bot.
      if (!notify || !telegramReachable(u)) continue;
      const lang = (u.language ?? "en") as Language;
      await api
        .sendMessage(Number(u.telegramId), t(lang, "coordProxyClosed"))
        .catch((err: unknown) =>
          console.warn(
            `[coordination] proxy-close send failed for ${u.telegramId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
    }

    await prisma.match.update({
      where: { id: match.id },
      data: { proxyClosedAt: now },
    });
    result.closed++;
  }
}
