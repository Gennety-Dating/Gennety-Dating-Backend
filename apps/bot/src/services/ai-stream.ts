import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup, Message, MessageEntity } from "grammy/types";
import type { BotContext } from "../session.js";

/**
 * Streams a sequence of draft messages to the user, simulating a live AI
 * "internal monologue" while the backend analyses the profile.
 *
 * Uses Telegram Bot API 9.5 `sendMessageDraft`: successive calls with the
 * same `draft_id` animate as an update of the same draft on the client.
 * The draft must be finalised by sending a regular `sendMessage` with the
 * final text.
 *
 * @see https://core.telegram.org/bots/api#sendmessagedraft
 */

const DEFAULT_STEP_DELAY_MS = 900;

export interface StreamDraftOptions {
  /** Milliseconds between successive draft updates. Defaults to 900ms. */
  stepDelayMs?: number;
  /** Injectable wait function — used by tests to avoid real timers. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Send a sequence of draft chunks, then finalise with a regular message.
 *
 * @param ctx     grammY context — used to read chat id and call raw API
 * @param chunks  ordered list of draft texts; the *last* chunk is sent as the
 *                final (non-draft) message
 * @param options delay / wait override
 */
export async function streamDrafts(
  ctx: BotContext,
  chunks: readonly string[],
  options: StreamDraftOptions = {},
): Promise<void> {
  if (chunks.length === 0) return;

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // draft_id must be a non-zero integer; derive from chat id + timestamp so
  // concurrent users never collide and successive updates share the same id.
  const draftId = generateDraftId(chatId);

  const drafts = chunks.slice(0, -1);
  const finalText = chunks[chunks.length - 1]!;

  for (let i = 0; i < drafts.length; i++) {
    try {
      await ctx.api.raw.sendMessageDraft({
        chat_id: chatId,
        draft_id: draftId,
        text: drafts[i]!,
      });
    } catch (err) {
      // If the bot token / chat doesn't support drafts, degrade gracefully.
      console.warn("sendMessageDraft failed, aborting stream:", err);
      break;
    }
    if (i < drafts.length - 1) {
      await wait(stepDelayMs);
    }
  }

  // Short pause before the final message so the transition feels natural.
  if (drafts.length > 0) {
    await wait(stepDelayMs);
  }

  await ctx.reply(finalText);
}

// ---------------------------------------------------------------------------
// Self-replacing "live status" line
// ---------------------------------------------------------------------------

export interface StatusStep {
  /** Status line shown to the user for this step. */
  text: string;
  /** How long this text stays on screen before the next transition (ms). */
  holdMs: number;
}

export interface StatusSequenceOptions {
  /** Injectable wait function — tests pass a no-op to avoid real timers. */
  wait?: (ms: number) => Promise<void>;
  /**
   * When true (default) the status message is deleted after the final step so
   * the caller can send the real result message in its place. When false, the
   * final step's text is left on screen as a persistent line.
   */
  deleteAtEnd?: boolean;
}

/**
 * Render a self-replacing "agent is working" status line: a single message
 * that morphs through `steps` via `editMessageText`, each step held for its
 * own `holdMs`, then deleted (or left in place).
 *
 * This gives the user the felt sense of an agent actively analysing without
 * stacking a pile of messages or spamming a notification per step (only the
 * first `sendMessage` notifies; subsequent edits are silent). Degrades
 * silently if the chat rejects send/edit/delete (blocked bot, message too
 * old, identical-text edit, etc.) — a cosmetic status must never break the
 * real flow it decorates.
 */
export async function runStatusSequence(
  api: Api<RawApi>,
  chatId: number,
  steps: readonly StatusStep[],
  options: StatusSequenceOptions = {},
): Promise<void> {
  if (steps.length === 0) return;

  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deleteAtEnd = options.deleteAtEnd ?? true;

  let messageId: number;
  try {
    const sent = await api.sendMessage(chatId, steps[0]!.text);
    messageId = sent.message_id;
  } catch (err) {
    console.warn("runStatusSequence: initial send failed, skipping status:", err);
    return;
  }

  for (let i = 0; i < steps.length; i++) {
    await wait(steps[i]!.holdMs);
    const next = steps[i + 1];
    if (!next) break;
    try {
      await api.editMessageText(chatId, messageId, next.text);
    } catch {
      // An identical-text edit or a transient Bot API error must not abort the
      // remaining steps — keep morphing toward the final state.
    }
  }

  if (deleteAtEnd) {
    try {
      await api.deleteMessage(chatId, messageId);
    } catch {
      // Best-effort cleanup; leaving the last line up is acceptable.
    }
  }
}

/** Derive a stable, non-zero int32 draft id from the chat id. */
function generateDraftId(chatId: number): number {
  // 32-bit unsigned window, avoid 0 (Telegram requires non-zero).
  const base = Math.abs(chatId) ^ Date.now();
  const id = base % 0x7fffffff;
  return id === 0 ? 1 : id;
}

export interface StreamDraftsToApiOptions extends StreamDraftOptions {
  /** Optional inline keyboard attached to the final message. */
  replyMarkup?: InlineKeyboardMarkup;
  /** Optional message entities (e.g. `date_time`) on the final message. */
  entities?: MessageEntity[];
}

/**
 * Context-free draft streamer used when we don't have a grammY update
 * (e.g. the match engine pushing a proposal into a user's chat from a
 * cron tick). Takes a raw chat id and a grammY `Api` instance.
 *
 * Same behavior as `streamDrafts` — successive `sendMessageDraft` calls
 * sharing a `draft_id`, finalised with a regular `sendMessage`.
 */
export async function streamDraftsToChat(
  api: Api<RawApi>,
  chatId: number,
  chunks: readonly string[],
  options: StreamDraftsToApiOptions = {},
): Promise<Message.TextMessage | undefined> {
  if (chunks.length === 0) return undefined;

  const stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const draftId = generateDraftId(chatId);
  const drafts = chunks.slice(0, -1);
  const finalText = chunks[chunks.length - 1]!;

  for (let i = 0; i < drafts.length; i++) {
    try {
      await api.raw.sendMessageDraft({
        chat_id: chatId,
        draft_id: draftId,
        text: drafts[i]!,
      });
    } catch (err) {
      console.warn("sendMessageDraft failed (engine push), aborting stream:", err);
      break;
    }
    if (i < drafts.length - 1) {
      await wait(stepDelayMs);
    }
  }

  if (drafts.length > 0) {
    await wait(stepDelayMs);
  }

  return await api.sendMessage(chatId, finalText, {
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    ...(options.entities ? { entities: options.entities } : {}),
  });
}
