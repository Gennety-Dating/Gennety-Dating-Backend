import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup, Message, MessageEntity } from "grammy/types";
import type { BotContext } from "../session.js";
import { env } from "../config.js";
import {
  sendRichMessage,
  sendRichMessageDraft,
  thinkingHtml,
  type InputRichMessage,
} from "./telegram-rich.js";

/**
 * Streams a sequence of status chunks in the bottom of the chat by sending one
 * real message and editing it in place. We intentionally avoid Telegram's draft
 * APIs for product flows: clients treat drafts as generated AI replies and may
 * reserve scroll space for a follow-up message.
 */

const DEFAULT_STEP_DELAY_MS = 900;

export interface StreamDraftOptions {
  /** Milliseconds between successive message edits. Defaults to 900ms. */
  stepDelayMs?: number;
  /** Injectable wait function — used by tests to avoid real timers. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Send a sequence of chunks by editing one bottom-of-chat message in place.
 *
 * @param ctx     grammY context — used to read chat id and call the Bot API
 * @param chunks  ordered list of texts; the last chunk is the final text
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

  const finalText = chunks[chunks.length - 1]!;

  if (chunks.length === 1) {
    await ctx.reply(finalText);
    return;
  }

  let sent: Message.TextMessage;
  try {
    sent = await ctx.reply(chunks[0]!);
  } catch (err) {
    console.warn("streamDrafts: initial send failed, sending final reply:", err);
    await ctx.reply(finalText);
    return;
  }

  for (let i = 1; i < chunks.length; i++) {
    await wait(stepDelayMs);
    const isFinal = i === chunks.length - 1;
    try {
      await ctx.api.editMessageText(chatId, sent.message_id, chunks[i]!);
    } catch (err) {
      if (isFinal) {
        console.warn("streamDrafts: final edit failed, sending final reply:", err);
        await ctx.reply(chunks[i]!);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Self-replacing "live status" line
// ---------------------------------------------------------------------------

export interface StatusStep {
  /** Status line shown to the user for this step. */
  text: string;
  /** How long this text stays on screen before the next transition (ms). */
  holdMs: number;
  /**
   * Animated AI custom-emoji id leading THIS step's thinking block (rich path
   * only). Lets each step carry a distinct AIActions glyph. Falls back to
   * `options.thinkingEmojiId` → `env.CUSTOM_EMOJI_THINKING_ID` → the plain
   * leading glyph when unset.
   */
  emojiId?: string | undefined;
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
  /**
   * Explicit dev-only opt-in for Bot API 10.1 rich "thinking" drafts
   * (services/telegram-rich.ts). Product flows leave this unset so statuses stay
   * as ordinary bottom-of-chat messages instead of Telegram AI-draft previews.
   */
  rich?: boolean;
  /**
   * Animated AI custom-emoji id leading each thinking block (rich path only).
   * Defaults to `env.CUSTOM_EMOJI_THINKING_ID`; empty → plain glyph, no animation.
   * Overridden per step by `StatusStep.emojiId`.
   */
  thinkingEmojiId?: string;
  /**
   * Track a real, variable-length unit of work. When provided, the sequence
   * stops being a fixed-duration stub and instead *covers* the work:
   *  - if `until` settles while steps are still playing, narration is cut short
   *    (the work is done, no need to keep pretending);
   *  - if the scripted steps finish while `until` is still pending, the LAST
   *    step is held on screen until it settles, then the status is cleaned up.
   * Used for the date-card PNG render, where the wait is genuine. Without it the
   * behaviour is exactly the legacy fixed-duration stub. Rejections settle too
   * (a failed render must still tear down the status).
   */
  until?: Promise<unknown>;
  /**
   * Ignore `until` until this zero-based step index. Useful when early beats
   * are intentional pacing but the final beat should be held for real work.
   * Defaults to 0, so existing `until` behaviour can cut narration short from
   * the first step.
   */
  untilFromStepIndex?: number;
  /**
   * Rich path only: while holding the last step waiting on `until`, re-issue the
   * `<tg-thinking>` draft on this wall-clock interval so the ephemeral (~30s)
   * draft never expires mid-work. Defaults to 20s. Ignored without `until`.
   */
  keepAliveMs?: number;
}

/** Default wall-clock interval for refreshing a held rich `<tg-thinking>` draft. */
const DEFAULT_KEEPALIVE_MS = 20_000;

interface SettleTracker {
  /** Resolves when `until` settles (fulfilled OR rejected); undefined without `until`. */
  promise?: Promise<void>;
  /** Whether `until` has already settled. */
  settled: () => boolean;
}

const INERT_SETTLE: SettleTracker = { settled: () => false };

/**
 * Wrap an optional `until` work-promise into a settle tracker. Both fulfilment
 * and rejection count as "settled" — a failed render must still tear the status
 * down. Returns a no-op tracker (`settled()` always false) when `until` is absent.
 */
function makeSettle(until?: Promise<unknown>): SettleTracker {
  if (!until) return { settled: () => false };
  let done = false;
  const promise = until.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { promise, settled: () => done };
}

/**
 * Hold one step for its `holdMs`, racing against the tracked work. Returns true
 * when the work settled during the hold (caller should stop narrating). Without
 * a tracked work-promise this is just `await wait(ms)` and always returns false,
 * preserving the legacy fixed-duration behaviour.
 */
async function holdStep(
  wait: (ms: number) => Promise<void>,
  ms: number,
  settle: SettleTracker,
): Promise<boolean> {
  if (!settle.promise) {
    await wait(ms);
    return false;
  }
  await Promise.race([wait(ms), settle.promise]);
  return settle.settled();
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

  // Rich thinking drafts are opt-in only. They look nice, but Telegram clients
  // treat them as generated AI replies and can scroll/reserve space for output.
  if (options.rich === true) {
    const handled = await runThinkingStatusSequence(api, chatId, steps, options);
    if (handled) return;
  }

  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deleteAtEnd = options.deleteAtEnd ?? true;
  const settle = makeSettle(options.until);
  const untilFromStepIndex = options.untilFromStepIndex ?? 0;

  let messageId: number;
  try {
    const sent = await api.sendMessage(chatId, steps[0]!.text);
    messageId = sent.message_id;
  } catch (err) {
    console.warn("runStatusSequence: initial send failed, skipping status:", err);
    return;
  }

  for (let i = 0; i < steps.length; i++) {
    const stepSettle = i >= untilFromStepIndex ? settle : INERT_SETTLE;
    const settled = await holdStep(wait, steps[i]!.holdMs, stepSettle);
    if (settled) break; // tracked work finished — stop morphing
    const next = steps[i + 1];
    if (!next) break;
    try {
      await api.editMessageText(chatId, messageId, next.text);
    } catch {
      // An identical-text edit or a transient Bot API error must not abort the
      // remaining steps — keep morphing toward the final state.
    }
  }

  // Hold the last line in place until the tracked work finishes (no-op without
  // `until`). The classic edited message simply persists while we wait.
  if (settle.promise && !settle.settled()) {
    await settle.promise;
  }

  if (deleteAtEnd) {
    try {
      await api.deleteMessage(chatId, messageId);
    } catch {
      // Best-effort cleanup; leaving the last line up is acceptable.
    }
  }
}

/**
 * Bot API 10.1 rich-shimmer variant of {@link runStatusSequence}. Streams each
 * status step as a `<tg-thinking>` shimmer draft, holding each for its own
 * `holdMs` — identical timing to the classic path. The ephemeral draft expires
 * on its own (~30s) once the flow's real next message arrives, so for
 * `deleteAtEnd: true` (the default) nothing is sent after the steps. For
 * `deleteAtEnd: false` the final step's text is persisted as a real message,
 * mirroring the classic "leave the last line in place" behaviour.
 *
 * Returns `true` when the rich path was used (even if a later step failed
 * mid-stream — that is purely cosmetic). Returns `false` only when the very
 * first draft fails before anything was shown, so the caller can fall back to
 * the classic sequence.
 */
export async function runThinkingStatusSequence(
  api: Api<RawApi>,
  chatId: number,
  steps: readonly StatusStep[],
  options: StatusSequenceOptions = {},
): Promise<boolean> {
  if (steps.length === 0) return true;

  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deleteAtEnd = options.deleteAtEnd ?? true;
  const draftId = generateDraftId(chatId);
  const settle = makeSettle(options.until);
  const untilFromStepIndex = options.untilFromStepIndex ?? 0;

  // For a persistent final line the last step is finalised as a real message
  // rather than an ephemeral draft (which would vanish after ~30s).
  const lastIndex = steps.length - 1;
  const thinkingCount = deleteAtEnd ? steps.length : steps.length - 1;

  // Track the last successfully-issued draft so we can keep it alive while
  // waiting on real work (the ephemeral draft would otherwise expire mid-render).
  let lastDrawnHtml: string | undefined;
  let workSettledMidStream = false;

  for (let i = 0; i < thinkingCount; i++) {
    const step = steps[i]!;
    const emojiId =
      (step.emojiId ?? options.thinkingEmojiId ?? env.CUSTOM_EMOJI_THINKING_ID) || undefined;
    const html = thinkingHtml(step.text, emojiId);
    try {
      await sendRichMessageDraft(api, {
        chat_id: chatId,
        draft_id: draftId,
        rich_message: { html },
      });
      lastDrawnHtml = html;
    } catch (err) {
      if (i === 0) {
        console.warn(
          "runThinkingStatusSequence: rich draft unsupported, falling back:",
          err,
        );
        return false;
      }
      // A later draft failed — stop the shimmer but keep the flow intact.
      console.warn("runThinkingStatusSequence: rich draft failed mid-stream:", err);
      break;
    }
    const stepSettle = i >= untilFromStepIndex ? settle : INERT_SETTLE;
    if (await holdStep(wait, step.holdMs, stepSettle)) {
      workSettledMidStream = true;
      break; // tracked work finished — stop the shimmer
    }
  }

  // Hold the last shimmer alive until the tracked work finishes. The draft is
  // ephemeral (~30s), so for long real work re-issue it on a wall-clock interval.
  if (settle.promise && !workSettledMidStream && !settle.settled() && lastDrawnHtml) {
    await holdLastRichDraft(api, chatId, draftId, lastDrawnHtml, settle, options.keepAliveMs);
  }

  if (!deleteAtEnd) {
    const finalText = steps[lastIndex]!.text;
    try {
      await sendRichMessage(api, {
        chat_id: chatId,
        rich_message: { markdown: finalText },
      });
    } catch {
      // The rich finaliser may be unsupported — persist the line as plain text.
      try {
        await api.sendMessage(chatId, finalText);
      } catch {
        // Cosmetic between-batch line; losing it must never break the flow.
      }
    }
  }

  return true;
}

/**
 * Keep a rich `<tg-thinking>` draft on screen until `settle` resolves. The draft
 * is ephemeral (~30s), so we re-issue the same `draft_id`+html on a wall-clock
 * interval (default 20s) to refresh it during long real work; re-issue errors
 * just stop the refresh (cosmetic). Uses real `setInterval` — the interval is a
 * wall-clock concern (draft TTL), independent of the injectable step `wait`, so
 * fast tests that resolve `settle` quickly never fire it.
 */
async function holdLastRichDraft(
  api: Api<RawApi>,
  chatId: number,
  draftId: number,
  html: string,
  settle: SettleTracker,
  keepAliveMs: number = DEFAULT_KEEPALIVE_MS,
): Promise<void> {
  if (!settle.promise) return;
  const timer = setInterval(() => {
    void sendRichMessageDraft(api, {
      chat_id: chatId,
      draft_id: draftId,
      rich_message: { html },
    }).catch(() => {
      // A failed refresh is purely cosmetic; let the work finish regardless.
    });
  }, keepAliveMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    await settle.promise;
  } finally {
    clearInterval(timer);
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
  /**
   * Explicit dev-only opt-in for Bot API 10.1 rich message drafts
   * (services/telegram-rich.ts). Product flows leave this unset so streams stay
   * as ordinary bottom-of-chat message edits.
   */
  rich?: boolean;
  /**
   * Index into the stream chunks (the non-final entries) that should render as
   * a `<tg-thinking>` shimmer instead of plain markdown on explicit rich demos.
   * Ignored by product's normal edit stream.
   */
  thinkingIndex?: number;
  /**
   * Animated AI custom-emoji id leading the thinking chunk (rich path only).
   * Defaults to `env.CUSTOM_EMOJI_THINKING_ID`; empty → plain text, no animation.
   */
  thinkingEmojiId?: string;
}

/**
 * Context-free chunk streamer used when we don't have a grammY update
 * (e.g. the match engine pushing a proposal into a user's chat from a
 * cron tick). Takes a raw chat id and a grammY `Api` instance.
 *
 * Same behavior as `streamDrafts`: one real message is sent at the bottom of the
 * chat, then edited through each chunk. The final edit carries the keyboard and
 * entities so callers still get a single persisted message id.
 */
export async function streamDraftsToChat(
  api: Api<RawApi>,
  chatId: number,
  chunks: readonly string[],
  options: StreamDraftsToApiOptions = {},
): Promise<Message.TextMessage | undefined> {
  if (chunks.length === 0) return undefined;

  // Rich drafts are explicit-only for the same scroll behavior reason as
  // runStatusSequence above. The env flag no longer upgrades product flows.
  if (options.rich === true) {
    const result = await streamRichDraftsToChat(api, chatId, chunks, options);
    if (result.handled) return result.message;
  }

  const stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const finalOptions = streamFinalOptions(options);

  const finalText = chunks[chunks.length - 1]!;

  if (chunks.length === 1) {
    return await api.sendMessage(chatId, finalText, finalOptions);
  }

  let current: Message.TextMessage;
  try {
    current = await api.sendMessage(chatId, chunks[0]!);
  } catch (err) {
    console.warn("streamDraftsToChat: initial send failed, sending final message:", err);
    return await api.sendMessage(chatId, finalText, finalOptions);
  }

  for (let i = 1; i < chunks.length; i++) {
    await wait(stepDelayMs);
    const isFinal = i === chunks.length - 1;
    try {
      const edited = await api.editMessageText(
        chatId,
        current.message_id,
        chunks[i]!,
        isFinal ? finalOptions : {},
      );
      if (isTextMessage(edited)) current = edited;
    } catch (err) {
      if (isFinal) {
        console.warn(
          "streamDraftsToChat: final edit failed, sending final message:",
          err,
        );
        return await api.sendMessage(chatId, chunks[i]!, finalOptions);
      }
    }
  }

  return current;
}

type StreamFinalOptions = {
  reply_markup?: InlineKeyboardMarkup;
  entities?: MessageEntity[];
};

function streamFinalOptions(options: StreamDraftsToApiOptions): StreamFinalOptions {
  const finalOptions: StreamFinalOptions = {};
  if (options.replyMarkup) finalOptions.reply_markup = options.replyMarkup;
  if (options.entities) finalOptions.entities = options.entities;
  return finalOptions;
}

function isTextMessage(value: unknown): value is Message.TextMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "message_id" in value &&
    "chat" in value
  );
}

export interface StreamRichResult {
  /** Whether the rich path handled the stream (false → caller should fall back). */
  handled: boolean;
  /** The final persisted message — present only when `handled`. */
  message?: Message.TextMessage;
}

/**
 * Bot API 10.1 rich-shimmer variant of {@link streamDraftsToChat}. Streams the
 * pitch as rich-message drafts — the chunk at `options.thinkingIndex` (the
 * "analysing…" beat) renders as a `<tg-thinking>` shimmer, the rest as growing
 * markdown — then persists the FINAL chunk via the ordinary `sendMessage`
 * (NOT `sendRichMessage`). The final must stay a plain text message because the
 * proposal-countdown worker live-edits it with `editMessageText`.
 *
 * Returns `{ handled: false }` (nothing sent) when the first draft fails, so the
 * caller can fall back to the normal bottom edit stream. A later draft failure
 * just stops the shimmer; the final message is still sent. The final
 * `sendMessage` errors propagate (the caller's `allSettled` handles them),
 * mirroring {@link streamDraftsToChat}.
 */
export async function streamRichDraftsToChat(
  api: Api<RawApi>,
  chatId: number,
  chunks: readonly string[],
  options: StreamDraftsToApiOptions = {},
): Promise<StreamRichResult> {
  if (chunks.length === 0) return { handled: true };

  const stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { thinkingIndex } = options;
  const emojiId = (options.thinkingEmojiId ?? env.CUSTOM_EMOJI_THINKING_ID) || undefined;

  const draftId = generateDraftId(chatId);
  const drafts = chunks.slice(0, -1);
  const finalText = chunks[chunks.length - 1]!;

  for (let i = 0; i < drafts.length; i++) {
    const richMessage: InputRichMessage =
      i === thinkingIndex
        ? { html: thinkingHtml(drafts[i]!, emojiId) }
        : { markdown: drafts[i]! };
    try {
      await sendRichMessageDraft(api, {
        chat_id: chatId,
        draft_id: draftId,
        rich_message: richMessage,
      });
    } catch (err) {
      if (i === 0) {
        console.warn(
          "streamRichDraftsToChat: rich draft unsupported, falling back:",
          err,
        );
        return { handled: false };
      }
      console.warn("streamRichDraftsToChat: rich draft failed mid-stream:", err);
      break;
    }
    if (i < drafts.length - 1) {
      await wait(stepDelayMs);
    }
  }

  if (drafts.length > 0) {
    await wait(stepDelayMs);
  }

  const message = await api.sendMessage(chatId, finalText, {
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    ...(options.entities ? { entities: options.entities } : {}),
  });
  return { handled: true, message };
}

export interface StreamComposedRichOptions {
  /** Inline keyboard attached to the final persisted message. */
  replyMarkup?: InlineKeyboardMarkup;
  /** Injectable wait — tests pass a no-op to skip real timers. */
  wait?: (ms: number) => Promise<void>;
  /** Delay between successive content-reveal drafts (defaults to 900ms). */
  stepDelayMs?: number;
  /** Fallback AI-emoji id for a beat without its own `emojiId` (rich path). */
  thinkingEmojiId?: string;
}

/**
 * Native Bot API 10.1 "AI is composing" delivery as **one** rich-message draft:
 * the `beats` render as `<tg-thinking>` shimmer (each held for its own `holdMs`,
 * leading glyph upgraded to an AI Actions `<tg-emoji>`), then `contentChunks`
 * stream in as growing rich-message drafts, and finally the LAST chunk is
 * persisted as a real text message (so an inline keyboard attaches and the draft
 * preview collapses into the message).
 *
 * Crucially everything shares a single `draft_id`, so the client reserves /
 * collapses the AI-answer scroll space exactly **once** per call — no mid-stream
 * jump from a separate status draft. Use this instead of a `runStatusSequence` +
 * `streamDraftsToChat` pair when the status and the streamed content should read
 * as one continuous compose.
 *
 * Falls back to the classic edited-message stream (status beats + content as one
 * bottom-of-chat message) when the very first rich draft fails (rich
 * unsupported). A later draft failure just skips ahead to the final send. The
 * final send mirrors `streamDraftsToChat` and returns the persisted message
 * (or undefined on failure) so callers can detect delivery.
 */
export async function streamComposedRich(
  api: Api<RawApi>,
  chatId: number,
  beats: readonly StatusStep[],
  contentChunks: readonly string[],
  options: StreamComposedRichOptions = {},
): Promise<Message | undefined> {
  if (contentChunks.length === 0) return undefined;

  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
  const draftId = generateDraftId(chatId);
  const finalText = contentChunks[contentChunks.length - 1]!;
  const partials = contentChunks.slice(0, -1);
  const finalOptions: StreamFinalOptions = options.replyMarkup
    ? { reply_markup: options.replyMarkup }
    : {};

  let richStarted = false;
  try {
    for (const beat of beats) {
      const emojiId =
        (beat.emojiId ?? options.thinkingEmojiId ?? env.CUSTOM_EMOJI_THINKING_ID) || undefined;
      await sendRichMessageDraft(api, {
        chat_id: chatId,
        draft_id: draftId,
        rich_message: { html: thinkingHtml(beat.text, emojiId) },
      });
      richStarted = true;
      await wait(beat.holdMs);
    }
    for (const part of partials) {
      await sendRichMessageDraft(api, {
        chat_id: chatId,
        draft_id: draftId,
        rich_message: { markdown: part },
      });
      await wait(stepDelayMs);
    }
  } catch (err) {
    if (!richStarted) {
      console.warn("streamComposedRich: rich unsupported, falling back to classic:", err);
      const chunks = [...beats.map((b) => b.text), ...contentChunks];
      return await streamDraftsToChat(api, chatId, chunks, {
        ...(options.replyMarkup ? { replyMarkup: options.replyMarkup } : {}),
        ...(options.wait ? { wait: options.wait } : {}),
      });
    }
    console.warn("streamComposedRich: rich draft failed mid-stream:", err);
  }

  // Finalise. When the rich draft stream ran, persist the final text as a proper
  // rich message (`sendRichMessage`) so Telegram resolves the streaming draft IN
  // PLACE — this collapses the reserved "AI answer" space cleanly, instead of
  // leaving an orphaned reserve under a separate plain message (the empty-gap
  // artifact visible on very short answers). Falls back to a plain message if the
  // rich finaliser is unavailable.
  if (richStarted) {
    try {
      return await sendRichMessage(api, {
        chat_id: chatId,
        rich_message: { markdown: finalText },
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      });
    } catch (err) {
      console.warn("streamComposedRich: rich final failed, falling back to plain send:", err);
    }
  }
  try {
    return await api.sendMessage(chatId, finalText, finalOptions);
  } catch (err) {
    console.warn("streamComposedRich: final send failed:", err);
    return undefined;
  }
}
