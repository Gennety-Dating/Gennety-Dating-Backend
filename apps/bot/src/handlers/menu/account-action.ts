import { randomBytes } from "node:crypto";
import { t } from "@gennety/shared";
import type { BotContext } from "../../session.js";

export const ACCOUNT_ACTION_TTL_MS = 10 * 60 * 1000;

export function newAccountActionNonce(): string {
  return randomBytes(12).toString("base64url");
}

export function setPendingAccountAction(
  ctx: BotContext,
  stage: "freeze_or_delete" | "delete_final",
  nonce: string,
  messageId: number,
  now: number = Date.now(),
): void {
  ctx.session.pendingAccountAction = {
    nonce,
    stage,
    messageId,
    expiresAtMs: now + ACCOUNT_ACTION_TTL_MS,
  };
}

export async function invalidatePendingAccountAction(ctx: BotContext): Promise<void> {
  const pending = ctx.session.pendingAccountAction;
  ctx.session.pendingAccountAction = null;
  if (!pending || !ctx.chat) return;
  await ctx.api.editMessageReplyMarkup(ctx.chat.id, pending.messageId).catch(() => {});
}

export async function consumePendingAccountAction(
  ctx: BotContext,
  stage: "freeze_or_delete" | "delete_final",
  callbackPrefix: string,
  now: number = Date.now(),
): Promise<boolean> {
  const pending = ctx.session.pendingAccountAction;
  const callbackData = ctx.callbackQuery?.data ?? "";
  const callbackMessageId = ctx.callbackQuery?.message?.message_id;
  const valid =
    pending !== null &&
    pending.stage === stage &&
    pending.expiresAtMs > now &&
    callbackMessageId === pending.messageId &&
    callbackData === `${callbackPrefix}${pending.nonce}`;

  if (!valid) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: t(ctx.session.language, "accountActionExpired"),
        show_alert: true,
      }).catch(() => {});
    }
    // Any malformed, stale, wrong-stage or replayed tap permanently burns the
    // current token. Strip both the stored confirmation keyboard and the one
    // that was actually tapped (they can differ for a forwarded/stale message).
    await invalidatePendingAccountAction(ctx);
    if (ctx.callbackQuery) await ctx.editMessageReplyMarkup().catch(() => {});
    return false;
  }

  // Consume before any destructive work. A retry always requires a new flow.
  ctx.session.pendingAccountAction = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  return true;
}
