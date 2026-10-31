/**
 * The private screenshot library's limits (decision journal 2026-10-31).
 * Costs behind them: docs/product/domains/screenshot-library.md.
 */
export const SCREENSHOT_CONSENT_VERSION = "2026-10-31";
export const SCREENSHOT_DEFAULT_RANGE_DAYS = 90;
export const SCREENSHOT_LIBRARY_MAX_ITEMS = 2_000;
export const SCREENSHOT_DAILY_INDEX_MAX = 1_000;
export const SCREENSHOT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
/** Longest side the phone sends: small print stays readable, bytes stay low. */
export const SCREENSHOT_MAX_DIMENSION = 1_600;
export const SCREENSHOT_MAX_PIXELS = 4_000_000;
export const SCREENSHOT_OCR_MAX_CHARS = 8_000;
export const SCREENSHOT_SEARCH_HITS = 8;
export const SCREENSHOT_CARD_MAX_ITEMS = 6;
export const SCREENSHOT_LIST_PAGE = 60;
export const SCREENSHOT_INDEX_MAX_ATTEMPTS = 5;
/** A reservation whose bytes never arrived is dropped after this long. */
export const SCREENSHOT_RESERVATION_TTL_MS = 24 * 3_600_000;
export const SCREENSHOT_SIGNED_URL_TTL_S = 3_600;
export const SCREENSHOT_CATEGORIES = ["place", "event", "thing", "other"] as const;
export type ScreenshotCategory = (typeof SCREENSHOT_CATEGORIES)[number];
