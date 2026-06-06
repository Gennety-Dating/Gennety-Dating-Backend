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
  language: string | null;
  firstName: string | null;
  gender: string | null;
  telegramUsername: string | null;
}

/**
 * Resolve who receives the T-60m offer. The female participant keeps the
 * safety-first framing (mirrors `pre-date-safety.ts`); a same-sex pair with no
 * female participant opens the offer to both, and whoever taps first becomes
 * the initiator. Only Telegram-present users (`telegramId > 0n`) are eligible.
 */
export function resolveCoordRecipients(
  a: CoordParticipant,
  b: CoordParticipant,
): CoordParticipant[] {
  const telegramBoth = [a, b].filter((u) => u.telegramId > 0n);
  if (telegramBoth.length < 2) return [];
  const females = telegramBoth.filter((u) => u.gender === "female");
  return females.length > 0 ? females : telegramBoth;
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
    kb.text(t(lang, "coordBtnShareSelf"), `coord:method:${matchId}:share_self`).row();
  }
  if (partnerHasUsername) {
    kb.text(t(lang, "coordBtnRequestPartner"), `coord:method:${matchId}:request_partner`).row();
  }
  kb.text(t(lang, "coordBtnProxy"), `coord:method:${matchId}:proxy`);
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
  language: true,
  firstName: true,
  gender: true,
  telegramUsername: true,
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
    const recipients = resolveCoordRecipients(match.userA, match.userB);
    // Even when there's nothing to send (e.g. a mobile-only participant),
    // stamp the marker so the sweep doesn't re-scan this row every tick.
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
          return api
            .sendMessage(Number(r.telegramId), intro, { reply_markup: kb })
            .catch((err: unknown) =>
              console.warn(
                `[coordination] offer send failed for ${r.telegramId}:`,
                err instanceof Error ? err.message : err,
              ),
            );
        }),
      );
      result.offers++;
    }

    await prisma.match.update({
      where: { id: match.id },
      data: { coordOfferSentAt: now },
    });
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
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });

  for (const match of matches) {
    const closesAt = new Date(
      match.agreedTime!.getTime() + PROXY_CLOSE_AFTER_HOURS * 60 * 60 * 1000,
    );

    for (const u of [match.userA, match.userB]) {
      if (u.telegramId <= 0n) continue;
      const lang = (u.language ?? "en") as Language;
      const kb = new InlineKeyboard().text(
        t(lang, "coordEnterBtn"),
        `coord:enter:${match.id}`,
      );
      await api
        .sendMessage(Number(u.telegramId), t(lang, "coordProxyOpenedEnterPrompt"), {
          reply_markup: kb,
        })
        .catch((err: unknown) =>
          console.warn(
            `[coordination] proxy-open send failed for ${u.telegramId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
    }

    await prisma.match.update({
      where: { id: match.id },
      data: { proxyOpenedAt: now, proxyClosesAt: closesAt },
    });
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
