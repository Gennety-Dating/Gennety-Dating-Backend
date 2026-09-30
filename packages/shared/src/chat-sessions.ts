/**
 * Chat sessions — ChatGPT-style chats with the app's agent (decision journal
 * 2026-09-30, reversing "one endless thread" of 2026-09-04). Limits, timings and
 * thresholds live here; the behaviour lives in `apps/bot/src/services/chat-*`.
 */

/**
 * A turn that names no chat (older app builds, the Telegram photo flow)
 * continues the most recent chat while its newest message is younger than this,
 * and opens a new one otherwise. Equal to `TOPIC_GAP_MS`, the silence the old
 * topic index and the migration's backfill cut the single stream at — so an
 * older build keeps landing in the conversations it always showed.
 */
export const CHAT_SESSION_LEGACY_GAP_MS = 6 * 60 * 60 * 1000;

/** `GET /v1/chat/sessions` page size. */
export const CHAT_SESSIONS_PAGE_DEFAULT = 30;
export const CHAT_SESSIONS_PAGE_MAX = 100;

/** A title set by hand (`PATCH /v1/chat/sessions/{id}`), after trimming. */
export const CHAT_SESSION_TITLE_MAX = 80;
/** A title written by the model, after sanitising. */
export const CHAT_SESSION_AUTO_TITLE_MAX = 60;
/** The untitled fallback: the person's opening line, condensed. */
export const CHAT_SESSION_FALLBACK_TITLE_MAX = 64;

/**
 * The automatic title is refreshed once the chat has grown by this many
 * messages since it was last titled — "the conversation has moved on". Never
 * for a title the person set by hand.
 */
export const CHAT_SESSION_RETITLE_AFTER_MESSAGES = 6;

/** Fewest non-system messages a chat needs before it is titled or summarized. */
export const CHAT_SESSION_DIGEST_MIN_MESSAGES = 2;

/**
 * The worker sweep only digests chats nobody has written in for this long —
 * a live conversation is titled by its own turns, and its summary would be
 * stale again a minute later.
 */
export const CHAT_SESSION_DIGEST_IDLE_MINUTES = 30;
/** Chats digested per worker tick (one small-model call + one embedding each). */
export const CHAT_SESSION_DIGEST_BATCH = 10;
/** Stale older chats summarized when a turn opens a new chat. */
export const CHAT_SESSION_DIGEST_ON_OPEN = 3;
/**
 * A chat summarized once and untouched for this long is never rescanned — its
 * summary cannot be stale, because any new message would have moved
 * `updatedAt` inside the window.
 */
export const CHAT_SESSION_DIGEST_RESCAN_DAYS = 7;
/** Transcript fed to the titler / summarizer: newest messages, capped twice. */
export const CHAT_SESSION_DIGEST_MESSAGES = 80;
export const CHAT_SESSION_DIGEST_CHARS = 12_000;
/** A stored summary is cut here — the model is asked for 3–6 sentences. */
export const CHAT_SESSION_SUMMARY_MAX = 2_000;

/** `search_past_chats`: hits returned, and how many of them keyword matches may take. */
export const PAST_CHAT_SEARCH_HITS = 5;
export const PAST_CHAT_KEYWORD_HITS = 2;
/** `read_past_chat`: newest messages of the chat, capped by characters too. */
export const PAST_CHAT_READ_MESSAGES = 60;
export const PAST_CHAT_READ_CHARS = 12_000;
/** `datesAround`: dates scheduled this many days either side of a chat count. */
export const PAST_CHAT_DATES_WINDOW_DAYS = 14;
/** At most this many dates ride along with one chat. */
export const PAST_CHAT_DATES_MAX = 5;
