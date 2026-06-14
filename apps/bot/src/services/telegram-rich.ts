import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup, Message } from "grammy/types";

/**
 * Isolated, typed wrapper for the Telegram Bot API 10.1 "Rich Messages"
 * surface (released 2026-06-11). We use exactly two methods:
 *
 *  - `sendRichMessageDraft` — streams an ephemeral (~30s) rich-message draft;
 *    successive calls sharing a `draft_id` animate on the client.
 *  - `sendRichMessage`      — persists a final rich message.
 *
 * The point of interest for us is the `RichBlockThinking` block — a client-side
 * "Thinking…" shimmer — which, per the docs, "corresponds to the custom HTML
 * tag <tg-thinking>" and "may be used only in sendRichMessageDraft". So a
 * thinking shimmer is authored by putting `<tg-thinking>…</tg-thinking>` inside
 * `InputRichMessage.html` and streaming it as a draft. See `thinkingHtml`.
 *
 * Why the cast: grammY's typings (`@grammyjs/types` ≤ 3.27.3) do not yet
 * describe these 10.1 methods, so they are absent from the typed `RawApi`
 * surface. At runtime grammY's `api.raw` is a Proxy that forwards ANY method
 * name through the normal transport (bot token, base URL, flood control), so
 * the calls work — we only need to escape the type system, here, in one
 * isolated and documented place (AGENTS.md: raw Bot API usage must be isolated
 * and justified). No `any`: the exact 10.1 request shapes are described below.
 *
 * @see https://core.telegram.org/bots/api#sendrichmessagedraft
 * @see https://core.telegram.org/bots/api#sendrichmessage
 * @see https://core.telegram.org/bots/api#richblockthinking
 * @see https://core.telegram.org/bots/api-changelog (June 11, 2026)
 */

/**
 * Bot API 10.1 `InputRichMessage`. Per the spec, **exactly one** of `html` or
 * `markdown` must be set.
 */
export interface InputRichMessage {
  /** Rich content described with HTML formatting (supports `<tg-thinking>`). */
  html?: string;
  /** Rich content described with Markdown formatting. */
  markdown?: string;
  /** Show the message right-to-left. */
  is_rtl?: boolean;
  /** Skip automatic entity detection (URLs, emails, …). */
  skip_entity_detection?: boolean;
}

export interface SendRichMessageDraftParams {
  /** Target private chat (rich drafts are private-chat only, like sendMessageDraft). */
  chat_id: number;
  message_thread_id?: number;
  /** Non-zero draft id; updates sharing the id animate as one draft. */
  draft_id: number;
  rich_message: InputRichMessage;
}

export interface SendRichMessageParams {
  business_connection_id?: string;
  chat_id: number | string;
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  rich_message: InputRichMessage;
  disable_notification?: boolean;
  protect_content?: boolean;
  allow_paid_broadcast?: boolean;
  message_effect_id?: string;
  reply_markup?: InlineKeyboardMarkup;
}

/** The subset of Bot API 10.1 methods we layer onto grammY's `api.raw`. */
interface RichRawApi {
  sendRichMessageDraft(params: SendRichMessageDraftParams): Promise<true>;
  sendRichMessage(params: SendRichMessageParams): Promise<Message>;
}

/**
 * View `api.raw` through the rich-method interface. grammY's `api.raw` is a
 * runtime Proxy forwarding any method name; these 10.1 methods simply aren't in
 * the static `RawApi` type yet. This is the single, justified type escape.
 */
function richRaw(api: Api<RawApi>): RichRawApi {
  return api.raw as unknown as RichRawApi;
}

/** Stream an ephemeral rich-message draft (Bot API 10.1). */
export function sendRichMessageDraft(
  api: Api<RawApi>,
  params: SendRichMessageDraftParams,
): Promise<true> {
  return richRaw(api).sendRichMessageDraft(params);
}

/** Persist a final rich message (Bot API 10.1). */
export function sendRichMessage(
  api: Api<RawApi>,
  params: SendRichMessageParams,
): Promise<Message> {
  return richRaw(api).sendRichMessage(params);
}

/** Escape a plain string for safe inclusion in `InputRichMessage.html`. */
export function escapeRichHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A leading emoji grapheme (+ optional VS16) followed by whitespace. */
const LEADING_EMOJI = /^(\p{Extended_Pictographic}️?)\s+([\s\S]+)$/u;

/**
 * Wrap a status label in the `<tg-thinking>` tag that renders as a
 * RichBlockThinking shimmer on Bot API 10.1 clients. The label is HTML-escaped.
 * Use only inside `sendRichMessageDraft` (the thinking block is draft-only).
 *
 * When `emojiId` is given and the label begins with a plain emoji, that leading
 * glyph is upgraded to the animated Telegram AI emoji via `<tg-emoji>` (the
 * AIActions pack Telegram recommends for this block); the plain glyph is the
 * non-Premium / pre-10.1 fallback. Without an `emojiId` the label is used
 * verbatim. Labels are kept short upstream so the block stays on one line.
 */
export function thinkingHtml(label: string, emojiId?: string): string {
  const match = emojiId ? label.match(LEADING_EMOJI) : null;
  if (match) {
    const [, glyph, rest] = match;
    return `<tg-thinking><tg-emoji emoji-id="${emojiId}">${escapeRichHtml(glyph!)}</tg-emoji> ${escapeRichHtml(rest!)}</tg-thinking>`;
  }
  return `<tg-thinking>${escapeRichHtml(label)}</tg-thinking>`;
}
