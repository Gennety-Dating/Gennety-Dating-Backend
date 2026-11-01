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
/** One page when the agent lists a kind or a period, for «все мои рестораны». */
export const SCREENSHOT_AGENT_LIST_PAGE = 20;
export const SCREENSHOT_CARD_MAX_ITEMS = 6;
export const SCREENSHOT_LIST_PAGE = 60;
export const SCREENSHOT_INDEX_MAX_ATTEMPTS = 5;
/** A reservation whose bytes never arrived is dropped after this long. */
export const SCREENSHOT_RESERVATION_TTL_MS = 24 * 3_600_000;
export const SCREENSHOT_SIGNED_URL_TTL_S = 3_600;
/**
 * What a screenshot shows, as the indexer stores it in `category`. One value per
 * line of the founder's list (decision journal 2026-11-01); `other` is the rest.
 * A description of the content, never of what the person wants from it.
 */
export const SCREENSHOT_KINDS = [
  "place",
  "event",
  "activity",
  "outfit",
  "item",
  "food",
  "aesthetic",
  "media",
  "text",
  "other",
] as const;
export type ScreenshotKind = (typeof SCREENSHOT_KINDS)[number];

/**
 * The four values on the wire since the first build. `ScreenshotItem.category`
 * is a closed enum in shipped clients, whose generated decoder fails the whole
 * page on an unknown value, so it stays these four for good and the finer value
 * travels as `kind`.
 */
export const SCREENSHOT_CATEGORIES = ["place", "event", "thing", "other"] as const;
export type ScreenshotCategory = (typeof SCREENSHOT_CATEGORIES)[number];

const LEGACY_CATEGORY: Readonly<Record<string, ScreenshotCategory>> = {
  place: "place",
  event: "event",
  thing: "thing",
  outfit: "thing",
  item: "thing",
};

/** The stored value as a shipped client may read it. Anything else is `other`. */
export function screenshotLegacyCategory(stored: string | null): ScreenshotCategory | null {
  return stored === null ? null : (LEGACY_CATEGORY[stored] ?? "other");
}

/** The stored value as `kind`. A row indexed before the kinds still says `thing`. */
export function screenshotKindOf(stored: string | null): ScreenshotKind | null {
  if (stored === null) return null;
  if (stored === "thing") return "item";
  return (SCREENSHOT_KINDS as readonly string[]).includes(stored) ? (stored as ScreenshotKind) : "other";
}

/** Stored values one kind covers: `item` also finds a row not yet reindexed. */
export function screenshotStoredValuesOfKind(kind: ScreenshotKind): string[] {
  return kind === "item" ? ["item", "thing"] : [kind];
}

/** Stored values an old client's `category` filter means. An unknown one finds nothing. */
export function screenshotStoredValuesOfCategory(category: string): string[] {
  return [...SCREENSHOT_KINDS, "thing"].filter((value) => screenshotLegacyCategory(value) === category);
}

/** Ceiling of one reading. A longer answer is cut, which `finish_reason` reports. */
export const SCREENSHOT_READING_MAX_TOKENS = 1_500;
/** Words the reading may copy off the image; the phone's OCR is kept apart. */
export const SCREENSHOT_READING_VISIBLE_TEXT_MAX_CHARS = 4_000;
/** Old rows re-read per tick, once nothing new is waiting. Bounds the cost per hour. */
export const SCREENSHOT_REINDEX_BATCH = 3;
/** A row that keeps failing its re-read stays as it was and is tried this rarely. */
export const SCREENSHOT_REINDEX_GIVE_UP_DELAY_MS = 7 * 24 * 3_600_000;
