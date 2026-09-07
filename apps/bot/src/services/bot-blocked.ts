import { GrammyError } from "grammy";
import type { Api, RawApi, Transformer } from "grammy";
import { prisma } from "@gennety/db";

/**
 * Remembering that Telegram has shut the door.
 *
 * A 403 from the Bot API is not a hiccup — it is the chat telling us it no
 * longer exists for us. That was already classified in `status-banner.ts`, and
 * the classification went nowhere: every send site read the refusal, swallowed
 * it with a `.catch(() => {})`, and the next weekly drop matched the person
 * again. Their partner then got a pitch, waited a day for an answer that could
 * not come, and the candidate was spent anyway — the lifetime pair ban is
 * written at creation. In a small pool that is invisible, compounding damage,
 * and from the outside it reads as "nobody was found for me".
 */

/**
 * A 403 is Telegram saying the CHAT is shut — blocked, deactivated, never
 * started, gone. The wording varies and changes; the code does not, and
 * matching on prose would only mean missing the next phrasing silently.
 *
 * Everything else stays transient by design. A 429 is an answer about this
 * second, a 5xx is Telegram's own problem, and "message to edit not found" is
 * about one message — none of them say the person cannot be reached again.
 */
function isPermanentChatRefusal(errorCode: number | undefined): boolean {
  return errorCode === 403;
}

/** The same rule, applied to a thrown `GrammyError`. */
export function isPermanentTelegramRefusal(err: unknown): boolean {
  return err instanceof GrammyError && isPermanentChatRefusal(err.error_code);
}

/** Stamp the door shut. Best-effort: this may never fail a send path. */
export async function markBotBlocked(telegramId: bigint): Promise<void> {
  if (telegramId <= 0n) return;
  await prisma.user
    .updateMany({
      where: { telegramId, botBlockedAt: null },
      data: { botBlockedAt: new Date() },
    })
    .then((result) => {
      if (result.count > 0) {
        console.warn(`[bot-blocked] telegramId=${telegramId} marked unreachable`);
      }
    })
    .catch((err: unknown) => {
      console.warn(`[bot-blocked] could not mark telegramId=${telegramId}:`, err);
    });
}

/**
 * Forget it. Any update from that chat is proof the door is open again —
 * stronger proof than a successful send, because it came from the person.
 */
export async function clearBotBlocked(telegramId: bigint): Promise<void> {
  if (telegramId <= 0n) return;
  await prisma.user
    .updateMany({
      where: { telegramId, botBlockedAt: { not: null } },
      data: { botBlockedAt: null },
    })
    .then((result) => {
      if (result.count > 0) {
        console.info(`[bot-blocked] telegramId=${telegramId} is reachable again`);
      }
    })
    .catch(() => {});
}

/**
 * Observe every outbound call and remember the terminal refusals.
 *
 * A transformer rather than 40 call sites: the refusal has to be recorded
 * wherever it happens, and "wherever it happens" is every send in the codebase,
 * most of which swallow their own errors on purpose. This sees them all, writes
 * nothing on the happy path, and never changes what the caller gets back.
 */
export function botBlockedObserver(): Transformer<RawApi> {
  return async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (result.ok) return result;
    if (!isPermanentChatRefusal(result.error_code)) return result;
    const chatId = (payload as { chat_id?: number | string } | undefined)?.chat_id;
    if (typeof chatId !== "number") return result;
    // Fire and forget: a refusal is already the failure the caller is handling,
    // and bookkeeping must not add a second one on top of it.
    void markBotBlocked(BigInt(chatId));
    return result;
  };
}

/** Install the observer on the main bot's Api. */
export function installBotBlockedObserver(api: Api<RawApi>): void {
  api.config.use(botBlockedObserver());
}
