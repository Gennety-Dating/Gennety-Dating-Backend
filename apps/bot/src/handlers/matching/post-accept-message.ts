import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup, ParseMode } from "grammy/types";
import { prisma } from "@gennety/db";
import { isTelegramTarget, toTelegramChatId } from "../../utils/telegram-target.js";

export type PostAcceptSide = "A" | "B";

export interface PostAcceptMessageOptions {
  parse_mode?: ParseMode;
  reply_markup?: InlineKeyboardMarkup;
  message_effect_id?: string;
}

export function postAcceptMessageIdUpdate(
  side: PostAcceptSide,
  messageId: number | null,
): { calendarMessageIdA: number | null } | { calendarMessageIdB: number | null } {
  return side === "A"
    ? { calendarMessageIdA: messageId }
    : { calendarMessageIdB: messageId };
}

function telegramErrorDescription(err: unknown): string {
  if (err instanceof Error) return err.message.toLowerCase();
  if (typeof err !== "object" || err === null || !("description" in err)) return "";
  const description = (err as { description?: unknown }).description;
  return typeof description === "string" ? description.toLowerCase() : "";
}

function messageIsUnavailable(err: unknown): boolean {
  const description = telegramErrorDescription(err);
  return (
    description.includes("message to edit not found") ||
    description.includes("message_id_invalid") ||
    description.includes("there is no text in the message to edit") ||
    description.includes("message can't be edited")
  );
}

function messageIsNotModified(err: unknown): boolean {
  return telegramErrorDescription(err).includes("message is not modified");
}

/**
 * Keep one live post-accept CTA/status message per side. It starts as the
 * "accepted, waiting" receipt, becomes the ticket gate, then becomes Calendar.
 */
export async function sendOrEditPostAcceptMessage(args: {
  api: Api<RawApi>;
  matchId: string;
  side: PostAcceptSide;
  telegramId: bigint;
  previousMessageId: number | null;
  text: string;
  options?: PostAcceptMessageOptions;
}): Promise<number | null> {
  const {
    api,
    matchId,
    side,
    telegramId,
    previousMessageId,
    text,
    options = {},
  } = args;
  if (!isTelegramTarget(telegramId)) return previousMessageId;

  const chatId = toTelegramChatId(telegramId);
  const { message_effect_id: _messageEffectId, ...editOptions } = options;

  if (previousMessageId !== null) {
    try {
      await api.editMessageText(chatId, previousMessageId, text, editOptions);
      return previousMessageId;
    } catch (err) {
      if (messageIsNotModified(err)) return previousMessageId;
      if (!messageIsUnavailable(err)) return previousMessageId;
    }
  }

  const sent = await api.sendMessage(chatId, text, options);
  await prisma.match.update({
    where: { id: matchId },
    data: postAcceptMessageIdUpdate(side, sent.message_id),
  });
  return sent.message_id;
}
