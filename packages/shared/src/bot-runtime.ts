/**
 * Bookkeeping limits and cadences for the bot process's own runtime: in-memory
 * caches that only save database round trips, and the runtime metrics line.
 * None of them changes what a user sees; each bounds memory or log volume.
 */

/**
 * Session rows whose stored JSON the adapter remembers between an update's
 * read and its write-back (`apps/bot/src/prisma-session-adapter.ts`). An entry
 * normally lives for one update; only updates that threw before the write-back
 * leave one behind, and the oldest of those is dropped first. A dropped entry
 * only means that update's write-back is not skipped.
 */
export const BOT_SESSION_SNAPSHOT_MAX_KEYS = 10_000;

/**
 * Telegram ids this process has already seen cleared of `botBlockedAt`
 * (`apps/bot/src/services/bot-blocked.ts`). Past the cap the oldest id is
 * forgotten, which only means its next inbound update runs the clearing UPDATE
 * again.
 */
export const BOT_REACHABLE_CACHE_MAX_IDS = 20_000;

/** How often the bot process logs its runtime metrics line. */
export const RUNTIME_METRICS_INTERVAL_MS = 60_000;

/** Sampling resolution of the event-loop delay histogram behind that line. */
export const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;

/**
 * Event-loop delay p99 at which the metrics line is logged as a warning rather
 * than as information. A fifth of a second is a pause that every update and
 * every HTTP request in the process sat through.
 */
export const EVENT_LOOP_DELAY_WARN_MS = 200;
