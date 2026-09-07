/**
 * Turning a `telegramId` into the chat id Telegram's API wants.
 *
 * This module used to also export `isTelegramTarget(telegramId) === id > 0n`,
 * used in 43 places as the test for "can the bot message this person". It was
 * the wrong test, and `services/telegram-reach.ts` had said so in its own
 * header since Telegram Login shipped: that rail stores a REAL positive id on
 * an app-only account, and the bot cannot open a chat with someone who never
 * pressed Start.
 *
 * Two definitions of one rule is a bug that does not throw. The wrong copy
 * addressed messages to people who would never see them — a pitch that reached
 * only one side, a partner waiting 24 hours for an answer, a candidate spent on
 * a lifetime pair ban — and the silence came back looking like a choice. So the
 * predicate is gone rather than deprecated: `telegramReachable` is the only
 * remaining answer, and it requires `platform`, which makes a forgotten
 * `select` a compile error instead of a quiet misdelivery.
 *
 * What survives here is the conversion, whose own guard is a defensive assert
 * about a value that should never have reached it — not a policy decision.
 */

/**
 * Convert a positive `telegramId` to the `number` Telegram's API expects.
 * Throws when called on a mobile-only synthetic id — call sites gate with
 * `telegramReachable` first. The throw is defensive, not the happy path; if it
 * ever fires, that path leaked a non-Telegram user.
 */
export function toTelegramChatId(telegramId: bigint): number {
  if (telegramId <= 0n) {
    throw new Error(
      `toTelegramChatId called with non-Telegram id (${telegramId})`,
    );
  }
  return Number(telegramId);
}
