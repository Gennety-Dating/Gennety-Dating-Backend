import { BotError, type MiddlewareFn } from "grammy";
import { BOT_CONCURRENT_CHAT_TASKS } from "@gennety/shared";
import type { BotContext } from "./session.js";

/**
 * Per-chat sequentialization queue.
 *
 * Updates for the same chat id are processed one-at-a-time. Without this,
 * Telegram album uploads (media groups) race on the shared session row —
 * each photo handler reads the same empty `pendingPhotos`, pushes its own
 * id, and the last write wins, losing earlier photos.
 *
 * Exposes `dispatchToChat` so out-of-band work (e.g. debounced
 * media-group flush from a `setTimeout` callback) can also serialize with
 * in-flight Telegram updates instead of racing them.
 *
 * **The queue is detached from grammY's polling loop (A13-H9).** grammY's
 * built-in `bot.start` awaits every update before it fetches the next one, and
 * this middleware used to await the chat's chain inside that loop — so one
 * 15-second agent turn in one chat held every other chat in the product, and a
 * `pre_checkout_query` behind it missed Telegram's 10-second window. Now an
 * update with a chat is appended to that chat's chain and the loop moves on at
 * once. Two exceptions stay inline, deliberately:
 *
 *   - `message.successful_payment` is still AWAITED through its chat's chain.
 *     The settlement code relies on redelivery after a crash, and grammY only
 *     confirms an update's offset once its handler has resolved.
 *   - A chat-less update (`pre_checkout_query`) runs inline as before; it has
 *     no chat to serialize on and must be answered immediately.
 *
 * A ceiling across chats (`BOT_CONCURRENT_CHAT_TASKS`) bounds how much runs at
 * once; queued work waits for a slot and still starts in per-chat order. The
 * awaited payment update does not take a slot: the polling loop it blocks is
 * already its limiter, and making it wait behind sixteen agent turns would put
 * back exactly the stall this removes.
 *
 * Detached work has nobody awaiting it, so its errors are routed to the handler
 * the caller passes (the bot's `bot.catch` handler) — never dropped, never an
 * unhandled rejection.
 */

export type DetachedErrorHandler = (err: BotError<BotContext>) => unknown;

export interface SequentializeOptions {
  /** Where a detached update's error goes — the same handler `bot.catch` uses. */
  onDetachedError: DetachedErrorHandler;
}

export interface ChatQueue {
  dispatchToChat<T>(chatId: number | string, task: () => Promise<T>): Promise<T>;
  sequentializeByChat(options: SequentializeOptions): MiddlewareFn<BotContext>;
  detachOnChat(ctx: BotContext, task: () => Promise<unknown>, onError: DetachedErrorHandler): void;
  /** Tasks enqueued and not yet settled (running or waiting), across all chats. */
  pendingTasks(): number;
  /** Resolves `true` once nothing is pending, or `false` when `timeoutMs` passes first. */
  waitForIdle(timeoutMs: number): Promise<boolean>;
  /** Shutdown: stop starting updates that reach the middleware from now on. */
  closeUpdateIntake(): void;
}

const noop = (): void => {};

export function createChatQueue(options: { maxConcurrent: number }): ChatQueue {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  const tails = new Map<string, Promise<unknown>>();
  let active = 0;
  const slotWaiters: Array<() => void> = [];
  let pending = 0;
  const idleWaiters = new Set<() => void>();
  let intakeOpen = true;

  function acquireSlot(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => slotWaiters.push(resolve));
  }

  function releaseSlot(): void {
    // Hand the slot straight to the oldest waiter rather than decrementing and
    // letting whoever asks next take it — FIFO is what keeps a busy chat from
    // starving a quiet one.
    const next = slotWaiters.shift();
    if (next) next();
    else active -= 1;
  }

  function settled(): void {
    pending -= 1;
    if (pending === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  }

  function enqueue<T>(key: string, task: () => Promise<T>, usesSlot: boolean): Promise<T> {
    pending += 1;
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.catch(noop).then(async () => {
      if (!usesSlot) return task();
      await acquireSlot();
      try {
        return await task();
      } finally {
        releaseSlot();
      }
    });
    tails.set(key, run);
    // The cleanup hook is a SEPARATE promise from the `run` we hand back, so it
    // needs its own rejection handler. Without the `.catch`, a task that throws
    // rejects this derived promise too — and nothing awaits it, so every handler
    // error raised one spurious `unhandledRejection` on top of the real error the
    // caller already caught. That both doubled the noise in the error log and
    // made "zero unhandled rejections" (a documented post-deploy health signal)
    // impossible to read. The `.catch` here swallows only this bookkeeping copy;
    // `run` itself still rejects to the caller exactly as before.
    void run
      .finally(() => {
        if (tails.get(key) === run) tails.delete(key);
        settled();
      })
      .catch(noop);
    return run;
  }

  function detach(
    key: string,
    ctx: BotContext,
    task: () => Promise<unknown>,
    onError: DetachedErrorHandler,
  ): void {
    enqueue(key, task, true).catch(async (err: unknown) => {
      try {
        await onError(new BotError<BotContext>(err, ctx));
      } catch (handlerErr) {
        // The error handler is the last line; if it breaks too, the log is all
        // that is left — and it must say both things.
        console.error("[chat-queue] detached error handler failed:", handlerErr, "original:", err);
      }
    });
  }

  return {
    dispatchToChat<T>(chatId: number | string, task: () => Promise<T>): Promise<T> {
      return enqueue(chatId.toString(), task, true);
    },

    sequentializeByChat({ onDetachedError }: SequentializeOptions): MiddlewareFn<BotContext> {
      return async (ctx, next) => {
        // Shutdown gate. `bot.stop()` confirms every update up to the one grammY
        // most recently handed to middleware; the gate is closed in the same
        // synchronous step, so whatever still arrives here (the rest of the
        // batch being walked) is NOT confirmed — skipping it means Telegram
        // redelivers it to the next process instead of this one half-running it.
        if (!intakeOpen) return;
        const key = ctx.chat?.id.toString();
        if (!key) return next();
        if (ctx.message?.successful_payment) {
          await enqueue(key, () => next(), false);
          return;
        }
        detach(key, ctx, () => next(), onDetachedError);
      };
    },

    detachOnChat(ctx: BotContext, task: () => Promise<unknown>, onError: DetachedErrorHandler): void {
      // A private chat's id IS the user's id, so `from` is the same queue when a
      // context carries no chat (a service-message shape, or a test double).
      const key = (ctx.chat?.id ?? ctx.from?.id)?.toString();
      if (!key) {
        void Promise.resolve()
          .then(task)
          .catch((err: unknown) => onError(new BotError<BotContext>(err, ctx)))
          .catch((handlerErr: unknown) =>
            console.error("[chat-queue] detached error handler failed:", handlerErr),
          );
        return;
      }
      detach(key, ctx, task, onError);
    },

    pendingTasks: () => pending,

    waitForIdle(timeoutMs: number): Promise<boolean> {
      if (pending === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const onIdle = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          idleWaiters.delete(onIdle);
          resolve(false);
        }, timeoutMs);
        idleWaiters.add(onIdle);
      });
    },

    closeUpdateIntake(): void {
      intakeOpen = false;
    },
  };
}

/** The process-wide queue every handler, debounce flush and cron entry point shares. */
const chatQueue = createChatQueue({ maxConcurrent: BOT_CONCURRENT_CHAT_TASKS });

export function sequentializeByChat(options: SequentializeOptions): MiddlewareFn<BotContext> {
  return chatQueue.sequentializeByChat(options);
}

/**
 * Enqueue work onto the serial queue for a given chat. Use this when
 * scheduling work from a non-update context (e.g. a debounce timer) so
 * the work serializes with any concurrent Telegram updates for the chat.
 *
 * Never AWAIT this from inside an update for the same chat: that update holds
 * the chat's chain, so the awaited task can only start after it — a deadlock.
 */
export function dispatchToChat<T>(
  chatId: number | string,
  task: () => Promise<T>,
): Promise<T> {
  return chatQueue.dispatchToChat(chatId, task);
}

/**
 * Run `task` after everything already queued for this chat — including the
 * update currently holding it — without anyone awaiting it. Its rejection is
 * wrapped in a `BotError` for `ctx` and handed to `onError`.
 */
export function detachOnChat(
  ctx: BotContext,
  task: () => Promise<unknown>,
  onError: DetachedErrorHandler,
): void {
  chatQueue.detachOnChat(ctx, task, onError);
}

export function chatQueueDepth(): number {
  return chatQueue.pendingTasks();
}

export function waitForChatQueueIdle(timeoutMs: number): Promise<boolean> {
  return chatQueue.waitForIdle(timeoutMs);
}

export function closeUpdateIntake(): void {
  chatQueue.closeUpdateIntake();
}
