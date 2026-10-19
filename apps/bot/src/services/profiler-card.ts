import { createHash } from "node:crypto";
import type { Api, RawApi } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import {
  profilerOptionText, profilerQuestionInput, profilerQuestionText, t,
  type Language, type ProfilerQuestion, type SessionData,
} from "@gennety/shared";
import { escapeRichHtml, sendRichMessage, editRichMessage } from "./telegram-rich.js";

export const PROFILER_CARD_PREFIX = "pc:";
export type ProfilerCardDraft = NonNullable<SessionData["profilerCardDraft"]>;

/** The real question id can include a UUID; callbacks stay below Telegram's 64 bytes. */
export function profilerCardToken(questionId: string): string {
  return createHash("sha256").update(questionId).digest("hex").slice(0, 12);
}

export function parseProfilerCardCallback(data: string): { token: string; revision: number; action: string } | null {
  const match = /^pc:([a-f0-9]{12}):(\d+):(skip|send|own|\d+)$/.exec(data);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { token: match[1]!, revision: Number(match[2]), action: match[3]! };
}

export function profilerCardContent(
  question: ProfilerQuestion, language: Language,
  draft?: Pick<ProfilerCardDraft, "optionIds" | "revision" | "writing">,
  context?: string | null,
): { html: string; text: string; keyboard: InlineKeyboardMarkup } {
  const input = profilerQuestionInput(question);
  const selected = draft?.optionIds ?? [];
  const callback = (action: string) => `${PROFILER_CARD_PREFIX}${profilerCardToken(question.id)}:${draft?.revision ?? 0}:${action}`;
  const rows: InlineKeyboardButton[][] = (input?.options ?? []).map((option, index) => [{
    text: `${selected.includes(option.id) ? "✓ " : ""}${profilerOptionText(option, language)}`,
    callback_data: callback(String(index)),
  }]);
  if (input && !input.closed && selected.length) {
    rows.push([{ text: t(language, "profilerCardSend"), callback_data: callback("send") }]);
  }
  rows.push([{ text: t(language, "profilerCardOwn"), callback_data: callback("own") },
    { text: t(language, "profilerSkip"), callback_data: callback("skip") }]);
  // Context remains visible above contextual questions, including after an edit.
  const text = [context, profilerQuestionText(question, language),
    t(language, draft?.writing ? "profilerCardWriting" : "profilerCardHint")].filter(Boolean).join("\n\n");
  const html = `<p>${escapeRichHtml(text).replace(/\n/g, "<br>")}</p>` + rows.map((row) =>
    `<tg-button-row>${row.map((button) => {
      if (!("callback_data" in button)) return "";
      return `<tg-button type="callback_data" data="${button.callback_data}">${escapeRichHtml(button.text)}</tg-button>`;
    }).join("")}</tg-button-row>`).join("");
  return { html, text, keyboard: { inline_keyboard: rows } };
}

/** Edit in place; an API that rejects rich content gets the same flow with inline buttons. */
export async function deliverProfilerCard(
  api: Api<RawApi>, chatId: number, question: ProfilerQuestion, language: Language,
  messageId?: number | null, draft?: ProfilerCardDraft, context?: string | null,
): Promise<number> {
  const card = profilerCardContent(question, language, draft, context);
  if (messageId) {
    try {
      await editRichMessage(api, { chat_id: chatId, message_id: messageId, rich_message: { html: card.html } });
      return messageId;
    } catch (error) {
      if (error instanceof Error && error.message.includes("message is not modified")) return messageId;
      if (!canFallback(error)) throw error;
      try {
        await api.editMessageText(chatId, messageId, card.text, { reply_markup: card.keyboard });
        return messageId;
      } catch (error) {
        if (error instanceof Error && error.message.includes("message is not modified")) return messageId;
        if (!canFallback(error)) throw error;
        // Deleted/uneditable message: deliver a replacement, with the same active question.
      }
    }
  }
  try {
    const message = await sendRichMessage(api, { chat_id: chatId, rich_message: { html: card.html } });
    return message.message_id;
  } catch (error) {
    if (!canFallback(error)) throw error;
    const message = await api.sendMessage(chatId, card.text, { reply_markup: card.keyboard });
    return message.message_id;
  }
}

/** Both embedded buttons and the classic fallback keyboard must become inactive. */
export async function closeProfilerCard(api: Api<RawApi>, chatId: number, messageId: number, language: Language, text = t(language, "profilerCardDone")): Promise<void> {
  try {
    await editRichMessage(api, { chat_id: chatId, message_id: messageId, rich_message: { html: escapeRichHtml(text) },
      reply_markup: { inline_keyboard: [] } });
  } catch {
    await api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } });
  }
}

/** Do not resend on timeouts/429/5xx: the first request might already have succeeded. */
function canFallback(error: unknown): boolean {
  const code = error && typeof error === "object" && "error_code" in error ? error.error_code : undefined;
  return code === 400 || code === 404;
}
