/**
 * `search_web` — the app chat agent's general web look-up (decision journal
 * 2026-11-28): shops, sales, prices, opening hours, addresses, news. The
 * wishlist and `check_event` keep their own narrow searches.
 */

/** Searches per person per UTC day. A cached answer is free. One search cost
 * ~15–21k tokens of the person's 180k daily budget before it was held to one
 * look-up inside (2026-11-28), ~9k after; eight leave the chat itself room. */
export const CHAT_WEB_SEARCHES_PER_DAY = 8;
/** Per turn: «search → look again» is enough; more is a loop. */
export const CHAT_WEB_SEARCHES_PER_TURN = 2;
/** The person is watching «Ищу в интернете…»; past this the agent says it could not check. */
export const CHAT_WEB_SEARCH_TIMEOUT_MS = 25_000;
/** Twelve short lines and a little thinking: measured 240–500 tokens. */
export const CHAT_WEB_SEARCH_MAX_OUTPUT_TOKENS = 800;
/** Sales and prices change within a day; an answer is reused only for a few hours. */
export const CHAT_WEB_SEARCH_CACHE_MS = 3 * 3_600_000;
/** «Nothing found» is remembered briefly, so the same question asked again
 * right away is not paid for twice; later the pages may well be up. */
export const CHAT_WEB_SEARCH_NOT_FOUND_CACHE_MS = 30 * 60_000;
/** What the agent may quote back: the summary and the pages it came from. */
export const CHAT_WEB_SEARCH_SUMMARY_MAX_CHARS = 2_000;
export const CHAT_WEB_SEARCH_MAX_SOURCES = 5;
export const CHAT_WEB_SEARCH_QUERY_MAX_LEN = 200;
