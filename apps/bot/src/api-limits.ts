import type { Api, RawApi } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { autoRetry } from "@grammyjs/auto-retry";

/**
 * Bot API limits, enforced on our side instead of Telegram's.
 *
 * Nothing paced outbound calls before this. `matchNudgeTick` alone runs five
 * notification loops in parallel with no delay between sends — comfortably past
 * the ~30 calls/second Telegram allows — and `retry_after` was read in exactly
 * one place in the whole codebase. Everywhere else a 429 was an ordinary
 * rejection, usually swallowed by a `.catch(() => {})`, so the message was lost
 * and nothing said so. Sustained overrun does not merely drop messages either:
 * Telegram can limit the bot as a whole.
 *
 * **Order is load-bearing, and grammY composes it back to front.**
 * `ApiClient.use` folds each transformer around the accumulated call, so the
 * LAST one listed ends up OUTERMOST — and a later `config.use(...)` wraps
 * around everything installed before it. Listing the throttler first therefore
 * puts `autoRetry` outside it, which is what we want: a retry re-enters the
 * queue and is paced like any other call. Inverted, the retry would fire
 * immediately past the very limiter that had just said we were going too fast.
 * `api-limits.test.ts` pins this by stubbing the transport as the transformer
 * installed FIRST — i.e. the innermost one.
 *
 * **`maxDelaySeconds` is a compromise with the payment path.** A
 * `pre_checkout_query` must be answered inside Telegram's 10s window or the
 * payment cancels silently, so sleeping a minute on a flood limit would be
 * worse than failing fast. Fifteen seconds covers the ordinary per-chat backoff
 * and gives up before a long flood wait can eat something time-critical.
 *
 * Internal server errors are rethrown rather than retried: a 500 from Telegram
 * is not a rate problem, and hammering it three more times helps nobody.
 */
export function installApiLimits(api: Api<RawApi>): void {
  api.config.use(
    apiThrottler(),
    autoRetry({
      maxRetryAttempts: 3,
      maxDelaySeconds: 15,
      rethrowInternalServerErrors: true,
    }),
  );
}
