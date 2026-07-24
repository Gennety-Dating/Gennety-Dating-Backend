import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { type Language, t } from "@gennety/shared";
import { env } from "../config.js";
import {
  grantReferralRewardsForVerifiedInvitee,
  nextLadderRung,
  type ReferralRewardResult,
} from "./referral.js";
import { sendPushToUser } from "./push.js";

/** Localized safety-net name for the (effectively unreachable) no-firstName case. */
const GENERIC_FRIEND: Record<Language, string> = {
  en: "A friend",
  ru: "Друг",
  uk: "Друг",
  de: "Ein Freund",
  pl: "Znajomy",
};

/**
 * Referral settlement + notification (§Referral). Called when `inviteeUserId`
 * reaches `verified`: settles the referrer's ladder rung(s) (idempotent) and,
 * when something was actually credited, DMs / pushes the referrer a celebratory
 * message. Best-effort — never throws, never blocks verification.
 */
export async function settleReferralOnVerified(
  inviteeUserId: string,
  api: Api<RawApi>,
): Promise<void> {
  let result: ReferralRewardResult | null = null;
  try {
    result = await grantReferralRewardsForVerifiedInvitee(inviteeUserId);
  } catch (err) {
    console.warn("[referral] settle failed", { inviteeUserId, err });
    return;
  }
  if (!result) return;
  // Held by the velocity guard, or nothing newly granted (a re-run): stay quiet.
  if (result.heldByVelocity) return;
  if (result.ticketsApplied === 0 && result.monthsApplied === 0) return;

  try {
    await notifyReferrerReward(result, inviteeUserId, api);
  } catch (err) {
    console.warn("[referral] reward notify failed", { referrerId: result.referrerId, err });
  }
}

async function notifyReferrerReward(
  result: ReferralRewardResult,
  inviteeUserId: string,
  api: Api<RawApi>,
): Promise<void> {
  const [referrer, invitee] = await Promise.all([
    prisma.user.findUnique({
      where: { id: result.referrerId },
      select: { telegramId: true, language: true, platform: true },
    }),
    prisma.user.findUnique({
      where: { id: inviteeUserId },
      select: { firstName: true },
    }),
  ]);
  if (!referrer) return;

  const lang = (referrer.language ?? "en") as Language;
  // Invitees always have a firstName by the time they verify (required onboarding
  // field), so this generic is effectively unreachable — a localized safety net.
  const name = invitee?.firstName?.trim() || GENERIC_FRIEND[lang];
  const next = nextLadderRung(result.verifiedCount);
  const nextText = next
    ? t(lang, "referralRewardNext", { remaining: next.remaining })
    : t(lang, "referralRewardNextMax");
  const body = t(lang, "referralRewardDm", {
    name,
    tickets: result.ticketsApplied,
    months: result.monthsApplied,
    next: nextText,
  });

  if (
    (referrer.platform === "telegram" || referrer.platform === "both") &&
    referrer.telegramId > 0n
  ) {
    const chatId = Number(referrer.telegramId);
    try {
      await api.sendMessage(chatId, body, {
        ...(env.MESSAGE_EFFECT_GIFT_ID ? { message_effect_id: env.MESSAGE_EFFECT_GIFT_ID } : {}),
      });
    } catch {
      // Retry without the effect (older clients reject unknown effect ids).
      await api.sendMessage(chatId, body).catch(() => {});
    }
  }

  if (referrer.platform === "mobile" || referrer.platform === "both") {
    await sendPushToUser(result.referrerId, { title: "Gennety", body }).catch(() => {});
  }
}
