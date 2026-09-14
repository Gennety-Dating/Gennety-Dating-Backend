import type { Api, RawApi, Transformer } from "grammy";
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
 *
 * **Network errors are rethrown too (A13-M23).** The plugin retries an
 * `HttpError` in a loop of its own that `maxRetryAttempts` does not bound, with
 * a backoff doubling up to an HOUR. A thirty-minute network outage therefore
 * left every send — and the long-poll itself — asleep for a further ~twenty
 * minutes after the network came back, and a message the caller had already
 * given up on could land late as a duplicate. A failed send now fails where it
 * was made, as it did before this plugin was installed.
 *
 * **`getUpdates` bypasses the retry entirely.** grammY's polling loop already
 * owns its backoff (3 s, or Telegram's `retry_after`) and it must stay the one
 * deciding when to poll again: a retry layered under it both stacks a second
 * backoff on top and hides 401/409 behind a sleep, which is precisely the
 * signal `index.ts` exits on.
 */
export function installApiLimits(api: Api<RawApi>): void {
  const retry = autoRetry({
    maxRetryAttempts: 3,
    maxDelaySeconds: 15,
    rethrowInternalServerErrors: true,
    rethrowHttpErrors: true,
  });
  const retryExceptPolling: Transformer = (prev, method, payload, signal) =>
    method === "getUpdates" ? prev(method, payload, signal) : retry(prev, method, payload, signal);
  api.config.use(apiThrottler(), retryExceptPolling);
}
