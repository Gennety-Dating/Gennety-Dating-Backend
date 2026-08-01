import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  getPremiumCancelContext,
  recordInChatCancellation,
  attachCancellationReason,
  formatPremiumUntil,
} from "../../services/premium.js";

/**
 * In-chat Gennety Premium cancellation (PRODUCT_SPEC §Premium). The menu agent
 * detects that the user wants to cancel and calls `offer_cancel_premium`, which
 * routes here. This module owns the deterministic, i18n-driven confirm card, the
 * nonce-bound confirm/keep callbacks, the real Telegram Stars cancel
 * (`editUserStarSubscription`), and the polite "why did you cancel?" follow-up
 * whose answer is stored on the `cancelled` SubscriptionLedger row.
 *
 * App Store subscribers can't be cancelled server-side (Apple owns that), so the
 * agent routes them to `sendPremiumCancelAppStoreGuide` instead of a button.
 *
 * The confirm keyboard is one-use and bound to a random nonce + the exact
 * message + a 10-minute expiry, mirroring the Freeze/Delete pattern.
 */

export const PREMIUM_CANCEL_TTL_MS = 10 * 60 * 1000;
export const PREM_CANCEL_YES_PREFIX = "prem:cancel:yes:";
export const PREM_CANCEL_KEEP_PREFIX = "prem:cancel:keep:";
export const PREM_CANCEL_FINAL_YES_PREFIX = "prem:cancel:final:yes:";
export const PREM_CANCEL_REASON_SKIP = "prem:cancel:reason:skip";

function newNonce(): string {
  return randomBytes(12).toString("base64url");
}

export async function invalidatePendingPremiumCancel(ctx: BotContext): Promise<void> {
  const pending = ctx.session.pendingPremiumCancel;
  ctx.session.pendingPremiumCancel = null;
  if (!pending || !ctx.chat) return;
  await ctx.api.editMessageReplyMarkup(ctx.chat.id, pending.messageId).catch(() => {});
}

/**
 * Consume the pending confirm token for a given stage + callback prefix. Any
 * malformed, stale, wrong-stage, or replayed tap burns the token and strips
 * the keyboard. On success the acted-on message's keyboard is also stripped,
 * so a stage-1 card can't be re-tapped after its stage-2 follow-up was sent.
 */
async function consumePremiumCancel(
  ctx: BotContext,
  stage: "offer" | "final",
  prefix: string,
  now: number = Date.now(),
): Promise<boolean> {
  const pending = ctx.session.pendingPremiumCancel;
  const data = ctx.callbackQuery?.data ?? "";
  const messageId = ctx.callbackQuery?.message?.message_id;
  const valid =
    pending !== null &&
    pending.stage === stage &&
    pending.expiresAtMs > now &&
    messageId === pending.messageId &&
    data === `${prefix}${pending.nonce}`;

  if (!valid) {
    await ctx
      .answerCallbackQuery({
        text: t(ctx.session.language, "accountActionExpired"),
        show_alert: true,
      })
      .catch(() => {});
    await invalidatePendingPremiumCancel(ctx);
    await ctx.editMessageReplyMarkup().catch(() => {});
    return false;
  }

  ctx.session.pendingPremiumCancel = null;
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageReplyMarkup().catch(() => {});
  return true;
}

/**
 * Send the deterministic confirm card + nonce keyboard for a Stars subscriber.
 * Re-derives premium state fresh (never trusts the agent-turn snapshot): a
 * lapsed sub → "no active subscription"; an App Store sub → the iOS guide.
 */
export async function sendPremiumCancelConfirm(ctx: BotContext): Promise<void> {
  // Defensive: burn any stale offer/final card before issuing a fresh one, so
  // a re-offered cancellation (e.g. the user re-asks mid-flow) never leaves
  // two live keyboards with only the newest nonce actually valid.
  await invalidatePendingPremiumCancel(ctx);

  const lang = ctx.session.language;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const cx = await getPremiumCancelContext(user.id);
  if (!cx.active) {
    await ctx.reply(t(lang, "premiumCancelNotActive"));
    return;
  }
  if (cx.provider === "app_store") {
    await sendPremiumCancelAppStoreGuide(ctx, cx.premiumUntil);
    return;
  }

  const nonce = newNonce();
  const keyboard = new InlineKeyboard()
    .text(t(lang, "premiumCancelConfirmYes"), `${PREM_CANCEL_YES_PREFIX}${nonce}`)
    .row()
    .text(t(lang, "premiumCancelKeepBtn"), `${PREM_CANCEL_KEEP_PREFIX}${nonce}`);

  const sent = await ctx.reply(
    t(lang, "premiumCancelConfirm", { date: formatPremiumUntil(cx.premiumUntil, lang) }),
    { reply_markup: keyboard },
  );

  ctx.session.pendingPremiumCancel = {
    nonce,
    stage: "offer",
    messageId: sent.message_id,
    expiresAtMs: Date.now() + PREMIUM_CANCEL_TTL_MS,
  };
}

/** Guide an App Store subscriber to cancel in iOS Settings (Apple owns it). */
export async function sendPremiumCancelAppStoreGuide(
  ctx: BotContext,
  premiumUntil?: Date | null,
): Promise<void> {
  const lang = ctx.session.language;
  let until: Date | null;
  if (premiumUntil === undefined) {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from!.id) },
      select: { premiumUntil: true },
    });
    until = user?.premiumUntil ?? null;
  } else {
    until = premiumUntil;
  }
  await ctx.reply(t(lang, "premiumCancelAppStore", { date: formatPremiumUntil(until, lang) }));
}

/** "Keep Premium" — burn the token, acknowledge, no state change. */
export async function handlePremiumCancelKeep(ctx: BotContext): Promise<void> {
  if (!(await consumePremiumCancel(ctx, "offer", PREM_CANCEL_KEEP_PREFIX))) return;
  const lang = ctx.session.language;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  const cx = user
    ? await getPremiumCancelContext(user.id)
    : { premiumUntil: null as Date | null };
  await ctx.editMessageText(
    t(lang, "premiumCancelKept", { date: formatPremiumUntil(cx.premiumUntil, lang) }),
  ).catch(() => {});
}

/**
 * "Yes, cancel" (stage 1) — does NOT cancel anything yet. Burns the offer
 * token, re-checks state (it can drift during the 10-minute window), and — for
 * a Stars subscriber — sends the isolated final-confirm card: one red button
 * that actually cancels, against two green back-out buttons that just
 * navigate to the main menu (the router's existing pending-token
 * cross-invalidation burns this card's nonce on that tap, so no dedicated
 * decline handler is needed — mirrors the Freeze/Delete final-confirm step).
 */
export async function handlePremiumCancelConfirm(ctx: BotContext): Promise<void> {
  if (!(await consumePremiumCancel(ctx, "offer", PREM_CANCEL_YES_PREFIX))) return;
  const lang = ctx.session.language;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const cx = await getPremiumCancelContext(user.id);
  if (!cx.active) {
    await ctx.editMessageText(t(lang, "premiumCancelNotActive")).catch(() => {});
    return;
  }
  if (cx.provider === "app_store") {
    await sendPremiumCancelAppStoreGuide(ctx, cx.premiumUntil);
    return;
  }

  const nonce = newNonce();
  const keyboard = new InlineKeyboard()
    .text(t(lang, "premiumCancelFinalNoSoft"), "menu:back")
    .success()
    .row()
    .text(t(lang, "premiumCancelFinalNoHard"), "menu:back")
    .success()
    .row()
    .text(t(lang, "premiumCancelFinalYes"), `${PREM_CANCEL_FINAL_YES_PREFIX}${nonce}`)
    .danger();

  const sent = await ctx.reply(
    t(lang, "premiumCancelFinalConfirm", { date: formatPremiumUntil(cx.premiumUntil, lang) }),
    { reply_markup: keyboard },
  );

  ctx.session.pendingPremiumCancel = {
    nonce,
    stage: "final",
    messageId: sent.message_id,
    expiresAtMs: Date.now() + PREMIUM_CANCEL_TTL_MS,
  };
}

/**
 * "Yes, I'm 100% sure, cancel" (stage 2) — the only tap that actually cancels
 * the Telegram Stars subscription at the provider, then records the DB
 * cancellation and asks (politely) for the churn reason. If the Stars API
 * cancel fails or there's no recurring anchor, we do NOT claim success
 * (Telegram would still auto-renew); we point the user to Telegram's own
 * Subscriptions settings instead.
 */
export async function handlePremiumCancelFinalConfirm(ctx: BotContext): Promise<void> {
  if (!(await consumePremiumCancel(ctx, "final", PREM_CANCEL_FINAL_YES_PREFIX))) return;
  const lang = ctx.session.language;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const cx = await getPremiumCancelContext(user.id);
  if (!cx.active) {
    await ctx.editMessageText(t(lang, "premiumCancelNotActive")).catch(() => {});
    return;
  }
  if (cx.provider === "app_store") {
    await sendPremiumCancelAppStoreGuide(ctx, cx.premiumUntil);
    return;
  }

  // Cancel at Telegram first — the DB entitlement head is only the mirror of
  // the provider's renewal state. If we can't stop the renewal, don't pretend.
  if (cx.recurringAnchor) {
    try {
      await ctx.api.editUserStarSubscription(ctx.from!.id, cx.recurringAnchor, true);
    } catch (err) {
      console.error("editUserStarSubscription failed:", err);
      await ctx.reply(t(lang, "premiumManageNote"));
      return;
    }
  } else {
    // Active but no recurring anchor recorded — we can't cancel it for them.
    await ctx.reply(t(lang, "premiumManageNote"));
    return;
  }

  const { ledgerId, premiumUntil } = await recordInChatCancellation(user.id, cx.provider);

  await ctx.editMessageText(
    t(lang, "premiumCancelDone", { date: formatPremiumUntil(premiumUntil, lang) }),
  ).catch(() => {});

  // Politely ask WHY; the next free-text message is captured as the reason.
  ctx.session.menuState = "awaiting_premium_cancel_reason";
  ctx.session.premiumCancelLedgerId = ledgerId;
  const skip = new InlineKeyboard().text(
    t(lang, "premiumCancelReasonSkipBtn"),
    PREM_CANCEL_REASON_SKIP,
  );
  await ctx.reply(t(lang, "premiumCancelReasonAsk"), { reply_markup: skip });
}

/** Reset the reason-capture sub-flow (shared by the submit + skip paths). */
function clearReasonState(ctx: BotContext): void {
  ctx.session.menuState = "idle";
  ctx.session.premiumCancelLedgerId = null;
}

/** The user typed their churn reason — store it and thank them. */
export async function handlePremiumCancelReasonInput(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const ledgerId = ctx.session.premiumCancelLedgerId;
  const text = ctx.message?.text?.trim() ?? "";
  clearReasonState(ctx);
  if (ledgerId && text) await attachCancellationReason(ledgerId, text);
  await ctx.reply(t(lang, "premiumCancelReasonThanks"));
}

/** The user tapped "Rather not say" — exit without storing a reason. */
export async function handlePremiumCancelReasonSkip(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageReplyMarkup().catch(() => {});
  clearReasonState(ctx);
  await ctx.reply(t(ctx.session.language, "premiumCancelReasonThanks"));
}
