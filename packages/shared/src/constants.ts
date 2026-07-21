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
  // Kharkiv universities whose student/corporate mail domains do not end in an
  // allowed suffix above. `isAllowedEmail` matches on `endsWith`, so each base
  // domain also admits student subdomains (e.g. `@student.karazin.ua`).
  "karazin.ua", // V. N. Karazin Kharkiv National University
  "kpi.kharkov.ua", // NTU "Kharkiv Polytechnic Institute" (KhPI)
  "nure.ua", // Kharkiv National University of Radio Electronics (NURE)
] as const;

/** OTP validity window in milliseconds (10 minutes) */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** OTP digit length */
export const OTP_LENGTH = 6;

/** Min/max photos allowed during onboarding */
export const MIN_PHOTOS = 4;
export const MAX_PHOTOS = 10;

/**
 * Profile-photo count that earns the one-time onboarding ticket bonus
 * (Date Ticket monetization, gated by `TICKET_FEATURE_ENABLED`). Reaching this
 * many face-validated photos grants +1 free ticket. This deliberately stays
 * below MAX_PHOTOS: the reward is earned at 6 photos, while users may keep
 * adding optional photos up to the 10-photo profile limit.
 */
export const PHOTO_BONUS_TICKET_THRESHOLD = 6;

/**
 * Registration v2 student loyalty: free Date Tickets granted once when a
 * university email is verified (the student track's welcome perk — the
 * general/phone track gets none). Gated by `TICKET_FEATURE_ENABLED`;
 * idempotent via the `student_bonus` TicketLedger claim.
 */
export const STUDENT_BONUS_TICKETS = 2;

/** Telegram Live Photo profile-media limits (Bot API 10.0) */
export const LIVE_PHOTO_MAX_DURATION_SECONDS = 10;
export const LIVE_PHOTO_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Profile video limits.
 *
 * The video is display-only: the bot stores its Telegram `file_id` and
 * re-sends it, so accepting and showing a large video has NO bot-side size cap
 * (Telegram hosts the file). The size ceiling only matters for the *safety
 * validation* path (`PROFILE_MEDIA_VALIDATION_ENABLED`), which downloads the
 * video via Bot API `getFile` — and the standard cloud Bot API `getFile`
 * refuses files over 20 MB.
 *
 * Raised to 100 MB (from 20 MB) because validation is currently off, so nothing
 * downloads the file. IMPORTANT: if `PROFILE_MEDIA_VALIDATION_ENABLED` is turned
 * on, videos between 20 MB and this ceiling will fail the `getFile` download
 * (rejected as "processing unavailable") unless the bot is pointed at a
 * self-hosted Telegram Bot API server, which raises the `getFile` limit to ~2 GB.
 */
export const PROFILE_VIDEO_MAX_DURATION_SECONDS = 60;
export const PROFILE_VIDEO_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
export const PROFILE_MEDIA_VALIDATION_VERSION = 1;

/** Profile media validation thresholds (upload-time gates). */
export const FACE_SIMILARITY_THRESHOLD = 0.6;
export const DUPLICATE_HASH_DISTANCE = 8;
export const VIDEO_FACE_PRESENCE_THRESHOLD = 0.25;
export const VIDEO_IDENTITY_MATCH_THRESHOLD = 0.5;
export const VIDEO_SAMPLE_TARGET_FRAMES = 12;

/**
 * Ticket store bundles for the pre-purchase Mini App. `priceCents` is the
 * TOTAL charged for the bundle; per-ticket price is `priceCents / count`.
 * Payment is mocked in v1 (`TICKET_PAYMENT_MODE=mock`).
 *   1 ticket  — $7.00  ($7.00/ea)
 *   3 tickets — $16.47 ($5.49/ea)
 *   6 tickets — $26.94 ($4.49/ea)
 */
export const TICKET_BUNDLES = [
  { count: 1, priceCents: 700 },
  { count: 3, priceCents: 1647 },
  { count: 6, priceCents: 2694 },
] as const;

export type TicketBundleSize = (typeof TICKET_BUNDLES)[number]["count"];

/** Look up a bundle by its ticket count; null for an unknown size. */
export function ticketBundleFor(
  count: number,
): { count: number; priceCents: number } | null {
  return TICKET_BUNDLES.find((b) => b.count === count) ?? null;
}

/**
 * "Famine" single-ticket discount (Date Ticket monetization, gated by
 * `TICKET_FEATURE_ENABLED`). A one-time loyalty perk granted when a user is
 * eligible-but-unpaired for a 2nd consecutive weekly batch (no-match tier >=
 * `FAMINE_DISCOUNT_MIN_TIER`). It discounts a SINGLE ticket purchase — the date
 * gate's `self` scope and the store's "1 ticket" bundle — by
 * `FAMINE_DISCOUNT_PCT`%, valid `FAMINE_DISCOUNT_TTL_DAYS` days, consumed on the
 * first such purchase. See PRODUCT_SPEC.md §3.5b.
 */
export const FAMINE_DISCOUNT_PCT = 77;
export const FAMINE_DISCOUNT_TTL_DAYS = 30;
export const FAMINE_DISCOUNT_MIN_TIER = 2;

/** Age boundaries */
export const MIN_AGE = 18;
export const MAX_AGE = 55;

/** Edit profile length limits */
export const MAX_BIO_LENGTH = 500;
export const MAX_PARTNER_PREFERENCES_LENGTH = 500;
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

/** Gennety Premium (§Premium, feature-flagged). */
/**
 * Telegram Stars subscription period, in seconds. Telegram Stars subscriptions
 * currently support ONLY a 30-day period, so this is fixed (not env-tunable).
 * The monthly price (Stars) is env-tunable (`PREMIUM_STARS`).
 */
export const PREMIUM_SUBSCRIPTION_PERIOD_SECONDS = 2_592_000;

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
 * Max total characters accepted for a Magic-Prompt response. The cap bounds
 * session-row growth and stops abuse loops while leaving ample headroom for
 * the structured profile payload.
 */
export const MAX_DUMP_BUFFER_CHARS = 32_000;

/** History management — controls memory window sent to the LLM */
/** Max total messages to send to the LLM API in a single call (safety cap) */
export const MAX_HISTORY_FOR_API = 80;
/** When stored history exceeds this, old messages are summarized */
export const SUMMARIZE_THRESHOLD = 50;
/** Number of recent messages always preserved during summarization/truncation */
export const KEEP_RECENT_MESSAGES = 30;
