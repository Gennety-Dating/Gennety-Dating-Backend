import { GrammyError } from "grammy";
import type { Api, RawApi, Transformer } from "grammy";
import { prisma } from "@gennety/db";
import { BOT_REACHABLE_CACHE_MAX_IDS } from "@gennety/shared";

/**
 * Remembering that Telegram has shut the door.
 *
 * A 403 from the Bot API is not a hiccup — it is the chat telling us it no
 * longer exists for us. That was already classified in `status-banner.ts`, and
 * the classification went nowhere: every send site read the refusal, swallowed
 * it with a `.catch(() => {})`, and the next scheduled drop matched the person
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

/**
 * The rails on which a 403 means the person shut the chat.
 *
 * An app-only account signed in through Telegram Login carries a REAL positive
 * id and never pressed Start, so a send to it is refused with the same 403 — a
 * refusal about a chat that never existed, not a door that closed. Stamping it
 * took that person out of every drop for good: eligibility requires a null
 * stamp, and only an incoming bot update clears it, which an app-only user
 * never sends. `platform` is NOT NULL with a `telegram` default, so rows that
 * predate the column already read `telegram` and keep being stamped.
 */
const BOT_CHAT_PLATFORMS = ["telegram", "both"] as const;

/**
 * Telegram ids whose `botBlockedAt` this process has itself seen cleared, so
 * the next inbound update from them can skip the clearing UPDATE — it would
 * match no row. Only two things can put a stamp back under an id: the stamp
 * itself (`markBotBlocked`) and an account adoption moving the id onto another
 * user row; both run inside `withBotReachabilityChange`. Bounded; insertion
 * order is age, and a forgotten id simply runs the UPDATE again. Empty after a
 * restart, so the first update from every chat still clears.
 */
const knownReachable = new Set<bigint>();

/**
 * Reachability changes started so far, and those not yet settled. A clear only
 * records its id when no change was in flight as it started and none started
 * before it settled: a change racing it may commit after it, and then the
 * stamp has to be cleared by the next update — exactly as it would have been
 * without this cache.
 */
let changesStarted = 0;
let changesInFlight = 0;

function rememberReachable(telegramId: bigint): void {
  knownReachable.delete(telegramId);
  knownReachable.add(telegramId);
  if (knownReachable.size > BOT_REACHABLE_CACHE_MAX_IDS) {
    const oldest = knownReachable.values().next().value;
    if (oldest !== undefined) knownReachable.delete(oldest);
  }
}

/**
 * Run `change`, which may leave a `botBlockedAt` stamp under `telegramId` —
 * the stamp itself, or moving the id onto a user row whose stamp this process
 * has never seen (account adoption). Until it settles no clear may record the
 * id as reachable, so every inbound update keeps running the clearing UPDATE.
 */
export async function withBotReachabilityChange<T>(
  telegramId: bigint,
  change: () => Promise<T>,
): Promise<T> {
  knownReachable.delete(telegramId);
  changesStarted += 1;
  changesInFlight += 1;
  try {
    return await change();
  } finally {
    changesInFlight -= 1;
  }
}

/** Test seam: the cache and the change counters are module state. */
export function __resetBotReachableForTests(): void {
  knownReachable.clear();
  changesStarted = 0;
  changesInFlight = 0;
}

/** Stamp the door shut. Best-effort: this may never fail a send path. */
export async function markBotBlocked(telegramId: bigint): Promise<void> {
  if (telegramId <= 0n) return;
  await withBotReachabilityChange(telegramId, () =>
    prisma.user
      .updateMany({
        where: { telegramId, botBlockedAt: null, platform: { in: [...BOT_CHAT_PLATFORMS] } },
        data: { botBlockedAt: new Date() },
      })
      .then((result) => {
        if (result.count > 0) {
          console.warn(`[bot-blocked] telegramId=${telegramId} marked unreachable`);
        }
      })
      .catch((err: unknown) => {
        console.warn(`[bot-blocked] could not mark telegramId=${telegramId}:`, err);
      }),
  );
}

/**
 * Forget it. Any update from that chat is proof the door is open again —
 * stronger proof than a successful send, because it came from the person.
 *
 * Runs before the flood gate on every inbound update, so the UPDATE is skipped
 * once this process has already cleared the id (see `knownReachable`): it
 * could only match a row stamped since, and every path that stamps one drops
 * the id first.
 */
export async function clearBotBlocked(telegramId: bigint): Promise<void> {
  if (telegramId <= 0n) return;
  if (knownReachable.has(telegramId)) return;
  const noChangeInFlight = changesInFlight === 0;
  const changesBefore = changesStarted;
  await prisma.user
    .updateMany({
      where: { telegramId, botBlockedAt: { not: null } },
      data: { botBlockedAt: null },
    })
    .then((result) => {
      if (result.count > 0) {
        console.info(`[bot-blocked] telegramId=${telegramId} is reachable again`);
      }
      if (noChangeInFlight && changesStarted === changesBefore) rememberReachable(telegramId);
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
