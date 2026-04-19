import type { BotContext } from "../session.js";

/**
 * Execute an async operation while continuously sending the "typing…"
 * chat action so the user sees a live indicator in the Telegram header.
 *
 * The action is sent immediately and then re-sent every 4 seconds
 * (Telegram's "typing" indicator expires after ~5s).
 */
export async function withTyping<T>(
  ctx: BotContext,
  fn: () => Promise<T>,
): Promise<T> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return fn();

  const send = () =>
    ctx.api.sendChatAction(chatId, "typing").catch(() => {
      /* swallow — non-critical */
    });

  await send();
  const interval = setInterval(send, 4_000);

  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}
