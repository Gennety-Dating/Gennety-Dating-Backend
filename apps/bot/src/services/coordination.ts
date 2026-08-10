import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
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
import { telegramReachable } from "./telegram-reach.js";
import type { CoordCardTheme } from "./coordination-card/index.js";

/**
 * Pre-date coordination service (PRODUCT_SPEC.md §Phase 4, feature-flagged
 * behind `COORDINATION_FEATURE_ENABLED`).
 *
 * Runs on the existing date-lifecycle `setInterval` tick. Three idempotent
 * responsibilities, each gated by a DB timestamp so retries / overlapping
 * ticks never double-send:
 *
 *   1. **Offer (T-60m)** — DM the initiator (the female participant, or in a
 *      same-sex pair both sides — first tap wins) three ways to find each
 *      other at the venue: share my Telegram (A), request the partner's (B),
 *      or an anonymous bot-relayed chat (C). The offered buttons depend on
 *      who actually has a public `telegramUsername` (A/B need a `t.me/` link).
 *   2. **Open proxy (T-30m)** — for matches whose initiator chose Variant C,
 *      open the anonymous window UNCONDITIONALLY (no partner consent — an
 *      offline partner must never strand the initiator) and DM both an
 *      "Enter chat" button.
 *   3. **Close proxy (T+2h)** — stamp the window closed and DM both.
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
  platform?: string | null;
  language: string | null;
  theme?: string | null;
  firstName: string | null;
  gender: string | null;
  telegramUsername: string | null;
  profile?: { photos: string[] } | null;
}

/**
 * Resolve who receives the T-60m offer. The female participant keeps the
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

/** Whether a match's anonymous proxy window is currently open. */
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

// 1. Offer at T-60m -----------------------------------------------------------
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
    // each other: the anonymous chat is selected for them and opens at T-30m
    // like any other. Two reasons this is the right default rather than a
    // second menu on the app. The choice the fork offers is between exchanging
    // Telegram handles and not exchanging them — meaningless to someone who
    // has no handle to give. And the product already decided this: ROADMAP and
    // PRODUCT_SPEC put contact exchange (variants A/B) in stage 2 and keep only
    // variant C in the MVP, so on the app there is nothing to choose BETWEEN.
    //
    // It writes the same two columns a tap writes, so `openProxies` below and
    // both relays treat such a pair identically — no second code path.
    if (recipients.length === 0) {
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
          // The face in the frame is the PARTNER: an hour out, the card's job
          // is "this is who you're about to meet", and the choice sits under it.
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

// 2. Open proxy at T-30m (unconditional once Variant C is chosen) -------------
async function openProxies(
  api: Api<RawApi>,
  now: Date,
  result: CoordinationResult,
): Promise<void> {
  const openWindowEnd = new Date(now.getTime() + PROXY_OPEN_HOURS * 60 * 60 * 1000);

  const matches = await prisma.match.findMany({
    where: {
      status: "scheduled",
      coordMethod: "proxy",
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

    for (const u of [match.userA, match.userB]) {
      // A mobile participant is told on their own rail. Before this the open
      // was a Telegram card and nothing else, so someone on the app got a
      // window they were never informed about — for the thirty minutes it
      // matters most.
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

    await prisma.match.update({
      where: { id: match.id },
      data: { proxyOpenedAt: now, proxyClosesAt: closesAt },
    });

    // The `chat_open` stage of the date-day Live Activity (§4.2) was declared
    // on both sides and deliberately never sent, because announcing an open
    // chat on a lock screen the app could not enter is a button into nowhere.
    // The app can enter it now, so the stage finally fires.
    await advanceDateDayActivities(match.id, "chat_open").catch(() => undefined);

    result.opened++;
  }
}

// 3. Close proxy at T+2h ------------------------------------------------------
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
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });

  for (const match of matches) {
    for (const u of [match.userA, match.userB]) {
      if (u.telegramId <= 0n) continue;
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
