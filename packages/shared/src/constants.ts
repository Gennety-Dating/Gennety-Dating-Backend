export const APP_NAME = "Gennety Dating";

/** Allowed university email domains (extend as needed) */
export const ALLOWED_EMAIL_DOMAINS = [
  ".edu",
  ".ac.uk",
  ".edu.au",
  ".ac.jp",
  ".edu.cn",
  ".ac.in",
  ".edu.ua",
  ".edu.ru",
  "kpi.ua",
  "knu.ua",
] as const;

/** OTP validity window in milliseconds (10 minutes) */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** OTP digit length */
export const OTP_LENGTH = 6;

/** Min/max photos allowed during onboarding */
export const MIN_PHOTOS = 2;
export const MAX_PHOTOS = 4;

/** Telegram Live Photo profile-media limits (Bot API 10.0) */
export const LIVE_PHOTO_MAX_DURATION_SECONDS = 10;
export const LIVE_PHOTO_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Age boundaries */
export const MIN_AGE = 18;
export const MAX_AGE = 35;

/** Edit profile length limits */
export const MAX_BIO_LENGTH = 500;
export const MAX_MAJOR_LENGTH = 100;

/** Phase 4: Date lifecycle timing */
/** How many hours before the date ice-breakers & emergency window unlock */
export const DATE_ALERT_HOURS = 5;
/** How many hours before the date the safety reminder is sent to female users */
export const PRE_DATE_SAFETY_HOURS = 1.5;
/** How many hours before the date the "Wingman" insider tip is revealed */
export const PRE_DATE_WINGMAN_HOURS = 1.5;
/** How many hours after the date we send the feedback prompt */
export const FEEDBACK_DELAY_HOURS = 24;

/**
 * Max total characters the Magic-Prompt buffer will hold across a user's
 * multi-message paste. Telegram caps a single message at 4096 chars, so
 * ~8 full messages is plenty of headroom for any legitimate LLM dump. The
 * cap exists to bound session-row growth and stop abuse loops.
 */
export const MAX_DUMP_BUFFER_CHARS = 32_000;

/** History management — controls memory window sent to the LLM */
/** Max total messages to send to the LLM API in a single call (safety cap) */
export const MAX_HISTORY_FOR_API = 80;
/** When stored history exceeds this, old messages are summarized */
export const SUMMARIZE_THRESHOLD = 50;
/** Number of recent messages always preserved during summarization/truncation */
export const KEEP_RECENT_MESSAGES = 30;
