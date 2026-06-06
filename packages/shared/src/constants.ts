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

/** Phase 4: Pre-date coordination timing (feature-flagged) */
/** How many hours before the date the coordination offer is sent to the initiator */
export const COORD_OFFER_HOURS = 1;
/** How many hours before the date the anonymous proxy chat opens for both sides */
export const PROXY_OPEN_HOURS = 0.5;
/** How many hours after the agreed time the anonymous proxy chat auto-closes */
export const PROXY_CLOSE_AFTER_HOURS = 2;
/** Max characters relayed per proxy message (matches the emergency-reason clamp) */
export const PROXY_MAX_MESSAGE_LEN = 1000;

/** Phase 3.7: Venue change (feature-flagged, female-exclusive one-shot) */
/**
 * Radius (km) around the original auto-assigned venue within which the
 * female may pick an alternative. The original venue is already the
 * fairness-balanced commute center, so a tight 3 km keeps each side's travel
 * time within ~±10–15 min and covers the nearest metro stops.
 */
export const VENUE_CHANGE_RADIUS_KM = 3;
/**
 * Hours the male has to accept/decline a proposed venue change before it
 * auto-expires. The effective deadline is `min(now + this, agreedTime -
 * DATE_ALERT_HOURS)` — the change must always resolve before the T-5h
 * ice-breaker / emergency window opens on the (possibly stale) venue.
 */
export const VENUE_CHANGE_TTL_HOURS = 12;
/** Minimum length of the mandatory explanation comment the female must write. */
export const VENUE_CHANGE_MIN_COMMENT_LEN = 10;
/** Max characters stored/relayed for the venue-change comment (emergency-reason clamp). */
export const VENUE_CHANGE_MAX_COMMENT_LEN = 1000;

/**
 * Phase 1b: Profiler (PRODUCT_SPEC §Phase 1b). Timed batches of gender-specific
 * Q&A harvested after onboarding to fuel icebreakers and date-planning hints.
 * NOT an input to the matching algorithm. All values are deliberately exported
 * config (not hard-coded inside the scheduler) so product can tune cadence and
 * the icebreaker weighting without touching logic.
 */
/** Delay after onboarding completion before the first Profiler question fires. */
export const PROFILER_ENTRY_DELAY_MS = 10 * 60 * 1000;
/** Normal-mode batch size (spec allows 3–4; we send up to this many per window). */
export const PROFILER_BATCH_SIZE_NORMAL = 3;
/** Rush-mode batch size when a drop is < PROFILER_RUSH_WINDOW_HOURS away (spec 1–2). */
export const PROFILER_BATCH_SIZE_RUSH = 2;
/** Quiet gap between batches; a new batch can only start in a daily window. */
export const PROFILER_INTER_BATCH_GAP_HOURS = 8;
/** Local wall-clock hour of the morning batch window. */
export const PROFILER_MORNING_HOUR = 9;
/** Local wall-clock hour of the evening batch window. */
export const PROFILER_EVENING_HOUR = 18;
/**
 * When the next drop is within this many hours, the Profiler switches to rush
 * mode: smaller batches but both daily windows used without skips.
 */
export const PROFILER_RUSH_WINDOW_HOURS = 48;
/** Max characters stored for a single free-text Profiler answer. */
export const PROFILER_MAX_ANSWER_LEN = 1000;
/**
 * Icebreaker / hint generation weighting (spec §5.3). `priority` weights
 * scale how much a partner's answer is emphasised; `penalty` coefficients
 * down-weight an answer when a pairwise incompatibility is detected. Hand-set
 * here, never inlined in the generator.
 */
export const PROFILER_PRIORITY_WEIGHTS: Record<"high" | "medium" | "low", number> = {
  high: 1.0,
  medium: 0.5,
  low: 0.2,
};
export const PROFILER_PENALTY_COEFFICIENTS = {
  /** Communication-style incompatibility between the pair. */
  commStyleMismatch: -0.8,
  /** Day-rhythm (lark/owl) incompatibility between the pair. */
  dayRhythmMismatch: -0.4,
};

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
