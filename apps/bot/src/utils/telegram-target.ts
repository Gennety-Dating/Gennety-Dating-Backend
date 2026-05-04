/**
 * Mobile-first synthetic users carry a NEGATIVE `telegramId` (see
 * `apps/bot/src/public/mobile-user.ts`) so they don't collide with real
 * Telegram chat ids. Sending to a negative chat id throws "chat not found"
 * — and historically (M-17) that exception bubbled up and aborted entire
 * fan-out batches.
 *
 * Use these helpers wherever a worker is about to call
 * `api.sendMessage(Number(user.telegramId), …)`. Calling code stays compact
 * and a single conversion point makes it obvious which paths are
 * Telegram-only vs platform-aware.
 */

/** True when this telegramId belongs to a real Telegram chat (positive). */
export function isTelegramTarget(telegramId: bigint | null | undefined): boolean {
  return telegramId !== null && telegramId !== undefined && telegramId > 0n;
}

/**
 * Convert a positive `telegramId` to the `number` Telegram's API expects.
 * Throws when called on a mobile-only synthetic id — call sites should
 * gate with `isTelegramTarget` first. The throw is defensive, not the
 * happy path; if it ever fires, that path leaked a non-Telegram user.
 */
export function toTelegramChatId(telegramId: bigint): number {
  if (telegramId <= 0n) {
    throw new Error(
      `toTelegramChatId called with non-Telegram id (${telegramId})`,
    );
  }
  return Number(telegramId);
}
