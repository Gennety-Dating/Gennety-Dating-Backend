import { type MiddlewareFn } from "grammy";
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
 */

const tails = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(task);
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
    })
    .catch(() => {});
  return run;
}

export function sequentializeByChat(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const key = ctx.chat?.id.toString();
    if (!key) return next();
    await enqueue(key, () => Promise.resolve(next()));
  };
}

/**
 * Enqueue work onto the serial queue for a given chat. Use this when
 * scheduling work from a non-update context (e.g. a debounce timer) so
 * the work serializes with any concurrent Telegram updates for the chat.
 */
export function dispatchToChat<T>(
  chatId: number | string,
  task: () => Promise<T>,
): Promise<T> {
  return enqueue(chatId.toString(), task);
}
