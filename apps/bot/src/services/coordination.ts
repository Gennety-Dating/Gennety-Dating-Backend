import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma, type Prisma } from "@gennety/db";
import {
  t,
  type Language,
  COORD_OFFER_HOURS,
  PROXY_OPEN_HOURS,
  PROXY_CLOSE_AFTER_HOURS,
} from "@gennety/shared";
import { env } from "../config.js";
import { sendCoordCard } from "./coordination-card/send.js";
import { sendPushToUser } from "./push.js";
import { advanceDateDayActivities } from "./date-day-activity.js";
import { pushReachable, telegramReachable } from "./telegram-reach.js";
import type { CoordCardTheme } from "./coordination-card/index.js";

/**
 * Pre-date coordination service (PRODUCT_SPEC.md §Phase 4, feature-flagged
 * behind `COORDINATION_FEATURE_ENABLED`).
 *
 * Runs on the existing date-lifecycle `setInterval` tick. Three idempotent
 * responsibilities, each gated by a DB timestamp so retries / overlapping
 * ticks never double-send:
 *
 *   1. **Offer (T-3h)** — DM the initiator (the female participant, or in a
 *      same-sex pair both sides — first tap wins) three ways to find each
 *      other at the venue: share my Telegram (A), request the partner's (B),
 *      or an anonymous bot-relayed chat (C). The offered buttons depend on
 *      who actually has a public `telegramUsername` (A/B need a `t.me/` link).
 *      Three hours out rather than one: Variant B needs the PARTNER to notice
 *      a card and tap it, and an hour was not enough runway for that.
 *   2. **Open proxy (T-1h)** — for matches whose initiator chose Variant C,
 *      or whose Variant B request ended without a yes, open the anonymous
 *      window UNCONDITIONALLY (no partner consent — an offline partner must
 *      never strand the initiator) and DM both an "Enter chat" button.
 *   3. **Close proxy (T+2h)** — stamp the window closed and DM both, unless
 *      the date was called off in the meantime.
 *
 * Telegram-only in v1: every gate requires `telegramId > 0n` on both sides
 * (mobile-only synthetic ids are skipped).
 */

export type CoordMethod = "share_self" | "request_partner" | "proxy";

export interface CoordinationResult {
  offers: number;
  opened: number;
  closed: number;
}

interface CoordParticipant {
  id: string;
  telegramId: bigint;
  /** Required: reachability is a platform question — see telegram-reach.ts. */
  platform: string | null;
  language: string | null;
  theme?: string | null;
  firstName: string | null;
  gender: string | null;
  telegramUsername: string | null;
  profile?: { photos: string[] } | null;
}

/**
 * Resolve who receives the T-3h offer. The female participant keeps the
 * safety-first framing (mirrors `pre-date-safety.ts`); a same-sex pair with no
 * female participant opens the offer to both, and whoever taps first becomes
 * the initiator.
 *
 * Empty when the fork cannot run at all — the offer's two contact-exchange
 * variants are `t.me/` links and its buttons are an inline keyboard, so both
 * need both sides in a bot chat. That case is not a dead end any more: see
 * `autoSelectProxy` in the offer sweep.
 */
export function resolveCoordRecipients(
  a: CoordParticipant,
  b: CoordParticipant,
): CoordParticipant[] {
  const reachable = [a, b].filter(telegramReachable);
  if (reachable.length < 2) return [];
  const females = reachable.filter((u) => u.gender === "female");
  return females.length > 0 ? females : reachable;
}

/**
 * Build the offer keyboard from a single recipient's perspective. "Share my
 * Telegram" (A) needs the recipient's own username; "Ask them for theirs" (B)
 * needs the partner's; the anonymous chat (C) is always available.
 */
export function buildCoordOfferKeyboard(
  matchId: string,
  lang: Language,
  recipientHasUsername: boolean,
  partnerHasUsername: boolean,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (recipientHasUsername) {
    kb.text(t(lang, "coordBtnShareSelf"), `coord:m:${matchId}:share_self`).row();
  }
  if (partnerHasUsername) {
    kb.text(t(lang, "coordBtnRequestPartner"), `coord:m:${matchId}:request_partner`).row();
  }
  kb.text(t(lang, "coordBtnProxy"), `coord:m:${matchId}:proxy`);
  return kb;
}

/** Persistent [Leave chat] [Report] controls shown on every proxy message. */
export function buildChatControlsKeyboard(matchId: string, lang: Language): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, "coordExitBtn"), "coord:exit")
    .text(t(lang, "coordReportBtn"), `report:open:${matchId}`);
}

/**
 * Whether the tick has announced a proxy window that has not yet reached its
 * stamped close. Window stamps only: it knows nothing about the match's status
 * or its coordination method, so it is NOT a gate on who may send — that is
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

const participantSelect = {
  id: true,
  telegramId: true,
  platform: true,
  language: true,
  // Card chrome follows the RECIPIENT's theme; the partner's first photo fills
  // the offer card's polaroid (PRODUCT_SPEC §Phase 4).
  theme: true,
  firstName: true,
  gender: true,
  telegramUsername: true,
  profile: { select: { photos: true } },
} as const;

/** Single coordination tick. Returns counts for logging / testing. */
export async function runCoordinationTick(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<CoordinationResult> {
  const result: CoordinationResult = { offers: 0, opened: 0, closed: 0 };
  if (!env.COORDINATION_FEATURE_ENABLED) return result;

  await sendOffers(api, now, result);
  await openProxies(api, now, result);
  await closeProxies(api, now, result);

  return result;
}

// 1. Offer at T-3h ------------------------------------------------------------
async function sendOffers(api: Api<RawApi>, now: Date, result: CoordinationResult): Promise<void> {
  const offerWindowEnd = new Date(now.getTime() + COORD_OFFER_HOURS * 60 * 60 * 1000);

  const matches = await prisma.match.findMany({
    where: {
      status: "scheduled",
      agreedTime: { gt: now, lte: offerWindowEnd },
      coordOfferSentAt: null,
    },
    select: {
      id: true,
      userA: { select: participantSelect },
      userB: { select: participantSelect },
    },
  });

  for (const match of matches) {
    const claim = await prisma.match.updateMany({
      where: { id: match.id, status: "scheduled", coordOfferSentAt: null },
      data: { coordOfferSentAt: now },
    });
    if (claim.count === 0) continue;

    const recipients = resolveCoordRecipients(match.userA, match.userB);

    // A pair the Telegram fork cannot reach is NOT left without a way to find
    // each other: the anonymous chat is selected for them and opens at T-1h
    // like any other. Two reasons this is the right default rather than a
    // second menu on the app. The choice the fork offers is between exchanging
    // Telegram handles and not exchanging them — meaningless to someone who
    // has no handle to give. And the product already decided this: ROADMAP and
    // PRODUCT_SPEC put contact exchange (variants A/B) in stage 2 and keep only
    // variant C in the MVP, so on the app there is nothing to choose BETWEEN.
    //
    // It writes the same two columns a tap writes, so `openProxies` below and
    // both relays treat such a pair identically — no second code path.
    //
    // **Since 2026-09-07 the same default covers any pair with the app in it**
    // (founder decision), not just one the fork cannot reach. The two
    // contact-exchange variants hand over a `t.me/` link, which moves the pair
    // onto Telegram three hours before they meet — so a pair that has an app
    // between them would finish coordinating on the surface the app cannot see,
    // and the screen built for exactly that hour would sit empty. One rail per
    // pair is worth more than a choice whose winning branch leaves.
    //
    // Deliberately `pushReachable` on EITHER side, not both: it takes only one
    // participant on the app for a contact exchange to split the pair.
    const onTheApp = pushReachable(match.userA) || pushReachable(match.userB);

    if (recipients.length === 0 || onTheApp) {
      await prisma.match.updateMany({
        where: { id: match.id, status: "scheduled", coordMethod: null },
        data: { coordMethod: "proxy", coordChosenAt: now },
      });
      continue;
    }

    if (recipients.length > 0) {
      await Promise.all(
        recipients.map((r) => {
          const partner = r.id === match.userA.id ? match.userB : match.userA;
          const lang = (r.language ?? "en") as Language;
          const recipientHasUsername = Boolean(r.telegramUsername);
          const partnerHasUsername = Boolean(partner.telegramUsername);
          const intro =
            recipientHasUsername || partnerHasUsername
              ? t(lang, "coordOfferIntro")
              : t(lang, "coordOfferNoContactNote");
          const kb = buildCoordOfferKeyboard(
            match.id,
            lang,
            recipientHasUsername,
            partnerHasUsername,
          );
          // The face in the frame is the PARTNER: a few hours out, the card's
          // job is "this is who you're about to meet", and the choice sits
          // under it.
          return sendCoordCard(
            api,
            r.telegramId,
            {
              variant: "offer",
              personName: partner.firstName ?? "",
              personPhotoRef: partner.profile?.photos?.[0] ?? null,
              language: lang,
              theme: (r.theme ?? "dark") as CoordCardTheme,
            },
            intro,
            { keyboard: kb },
          );
        }),
      );
      result.offers++;
    }

  }
}

// 2. Open proxy at T-1h (unconditional once Variant C is chosen) --------------

/**
 * A Variant B request nobody said yes to. Declined, or never answered by the
 * time the chat would open: either way no contact was exchanged, and the pair
 * still has to find each other at the venue in an hour. The decline card
 * promises the anonymous chat, and an unanswered ask is the same situation
 * with less said — so both are opened as the chat.
 *
 * `coordPartnerConsent` is spelled out as `null` OR `false` rather than
 * `{ not: true }`: that filter is SQL `<>`, which never matches NULL, and the
 * unanswered request is exactly the NULL row.
 */
const REQUEST_WITHOUT_CONSENT: Prisma.MatchWhereInput = {
  coordMethod: "request_partner",
  OR: [{ coordPartnerConsent: null }, { coordPartnerConsent: false }],
};

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
      OR: [{ coordMethod: "proxy" }, REQUEST_WITHOUT_CONSENT],
    },
    select: {
      id: true,
      agreedTime: true,
      coordMethod: true,
      userA: { select: { id: true, telegramId: true, platform: true, language: true, theme: true } },
      userB: { select: { id: true, telegramId: true, platform: true, language: true, theme: true } },
    },
  });

  for (const match of matches) {
    if (match.coordMethod === "request_partner") {
      // Moved onto the chat by a write that re-checks the request is still
      // unconsented — an approve landing between the read and here keeps the
      // contact exchange it just made. Writing the method, not special-casing
      // it downstream, is what lets both relays and the app's window read this
      // pair like any other proxy pair.
      const moved = await prisma.match.updateMany({
        where: { id: match.id, status: "scheduled", proxyOpenedAt: null, ...REQUEST_WITHOUT_CONSENT },
        data: { coordMethod: "proxy" },
      });
      if (moved.count === 0) continue;
    }

    const closesAt = new Date(
      match.agreedTime!.getTime() + PROXY_CLOSE_AFTER_HOURS * 60 * 60 * 1000,
    );

    // Claimed BEFORE anyone is told, by a write that only one tick can win.
    // Stamping after the sends let two overlapping ticks both read
    // `proxyOpenedAt: null` and both announce the chat — two cards, two pushes,
    // two Live Activity advances. It also re-checks the date is still on: a
    // cancellation between the read and here must not open a chat.
    const claim = await prisma.match.updateMany({
      where: { id: match.id, status: "scheduled", coordMethod: "proxy", proxyOpenedAt: null },
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

// 3. Close proxy at T+2h ------------------------------------------------------

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
      coordMethod: "proxy",
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
