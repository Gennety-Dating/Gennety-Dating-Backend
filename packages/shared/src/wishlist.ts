/**
 * Date Wishlist + «The Morning After» (decision journal 2026-10-08).
 *
 * A person builds a wishlist with the agent on «Сегодня» — perfume, flowers, a
 * place, a drink, a thing they would love. The morning after a date both sides
 * are asked one two-button question; when BOTH say "great", each is offered the
 * other's wishlist as a cheat sheet for the second date: about a tenth of it
 * free, the rest for one small purchase or with Premium.
 *
 * Shared by the bot (services, routes, Telegram) and the Mini App, so the
 * whitelists and limits below are the only copy.
 */

/** What an item is. The order is the catalog's and the cheat sheet's order. */
export const WISHLIST_CATEGORIES = [
  "place",
  "drink",
  "flowers",
  "perfume",
  "beauty",
  "fashion",
  "jewelry",
  "gift",
  "experience",
] as const;
export type WishlistCategory = (typeof WISHLIST_CATEGORIES)[number];

export function isWishlistCategory(value: unknown): value is WishlistCategory {
  return typeof value === "string" && (WISHLIST_CATEGORIES as readonly string[]).includes(value);
}

/**
 * How the item got onto the list: tapped in the catalog, found by the agent's
 * web search, read from a pasted link, or kept as the person's own words when
 * nothing real was found (or they wanted it that way).
 */
export const WISHLIST_SOURCES = ["catalog", "search", "link", "text"] as const;
export type WishlistSource = (typeof WISHLIST_SOURCES)[number];

export function isWishlistSource(value: unknown): value is WishlistSource {
  return typeof value === "string" && (WISHLIST_SOURCES as readonly string[]).includes(value);
}

/**
 * The price is never exact (the brief: "без точной цены либо со средним
 * диапазоном"). Bands in euros because the launch cities are Kyiv and Berlin
 * and shops in both quote EUR more often than UAH; the app renders the band,
 * never a number of its own.
 */
export const WISHLIST_PRICE_BANDS = ["€", "€€", "€€€", "€€€€"] as const;
export type WishlistPriceBand = (typeof WISHLIST_PRICE_BANDS)[number];

export function isWishlistPriceBand(value: unknown): value is WishlistPriceBand {
  return (
    typeof value === "string" && (WISHLIST_PRICE_BANDS as readonly string[]).includes(value)
  );
}

/** Upper bound of each band, EUR — used to turn a found price into a band. */
const PRICE_BAND_CEILINGS_EUR: Array<[number, WishlistPriceBand]> = [
  [30, "€"],
  [100, "€€"],
  [300, "€€€"],
  [Number.POSITIVE_INFINITY, "€€€€"],
];

/** A found price (in EUR) → its band. Non-finite / non-positive → null. */
export function wishlistPriceBandFor(eur: number): WishlistPriceBand | null {
  if (!Number.isFinite(eur) || eur <= 0) return null;
  for (const [ceiling, band] of PRICE_BAND_CEILINGS_EUR) {
    if (eur <= ceiling) return band;
  }
  return null;
}

/** Items one wishlist may hold. A cheat sheet, not a registry. */
export const WISHLIST_MAX_ITEMS = 30;
export const WISHLIST_TITLE_MAX_LEN = 120;
export const WISHLIST_NOTE_MAX_LEN = 200;
/** A pasted list is split into at most this many look-ups. */
export const WISHLIST_PASTE_MAX_ENTRIES = 12;
export const WISHLIST_PASTE_MAX_LEN = 4000;
/** Candidates the agent returns per look-up, for the person to confirm. */
export const WISHLIST_LOOKUP_MAX_CANDIDATES = 3;
/** Web look-ups (search or link read) one person may run per day. */
export const WISHLIST_LOOKUPS_PER_DAY = 30;
/** A cached look-up is reused this long. */
export const WISHLIST_LOOKUP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Largest image copied into our storage from a shop page. */
export const WISHLIST_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Screenshots one «Добавить скриншоты» sends at once (decision journal
 * 2026-10-08, third: «люди хранят скрины желанных вещей»). Read in ONE vision
 * call and never stored — only the items the person confirms are.
 */
export const WISHLIST_SCREENSHOTS_MAX = 6;
/** One screenshot as uploaded. The app sends a ≤2048 px JPEG, well under. */
export const WISHLIST_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The wishlist session takes a Profiler batch slot only after the person has
 * answered at least this many Profiler questions — never the first batch, so
 * the first days are about them, not their shopping.
 */
export const WISHLIST_SESSION_MIN_PROFILER_ANSWERS = 3;
/** «Позже» on the session: it may take a batch slot again after this. */
export const WISHLIST_SESSION_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The legal-docs version from which the policy discloses that taste answers
 * (favourite flowers) may be shown to a mutual match. A partner who accepted
 * an older version AND never built a wishlist (whose session says the same)
 * gets no flowers hint.
 */
export const LEGAL_DOCS_TASTE_HINTS_FROM = "2026-10-08";

/**
 * A cheat sheet whose newest change is at least this old carries a small
 * "this wishlist is N days old" line for the viewer — before the purchase too,
 * so they know it before paying. The founder (2026-10-08): only once the list
 * has most likely gone stale, "дней через 30, 40, 50".
 */
export const WISHLIST_STALE_AFTER_DAYS = 45;
/** From this age the line counts months instead of days. */
export const WISHLIST_AGE_IN_MONTHS_FROM_DAYS = 90;

/** Free share of the cheat sheet: a tenth, at least one item. */
export const WISHLIST_TEASER_SHARE = 0.1;

/** Categories the free teaser prefers — the brief: "1 любимое место или 1 напиток". */
const TEASER_PREFERRED: readonly WishlistCategory[] = ["place", "drink", "flowers"];

/** How many items of a list of `total` are free. */
export function wishlistTeaserCount(total: number): number {
  if (total <= 0) return 0;
  // A list of one would be given away whole; that is not a teaser, so a list
  // of one or two shows nothing free and the sheet is still worth opening.
  if (total <= 2) return 0;
  return Math.max(1, Math.floor(total * WISHLIST_TEASER_SHARE));
}

/**
 * Which items are free, by id, from a list in display order: preferred
 * categories first (a place, a drink, flowers), then the head of the list.
 * Deterministic, so the same viewer always sees the same free item.
 */
export function wishlistTeaserIds<T extends { id: string; category: string }>(items: T[]): string[] {
  const count = wishlistTeaserCount(items.length);
  if (count === 0) return [];
  const preferred = items.filter((item) =>
    (TEASER_PREFERRED as readonly string[]).includes(item.category),
  );
  const rest = items.filter(
    (item) => !(TEASER_PREFERRED as readonly string[]).includes(item.category),
  );
  return [...preferred, ...rest].slice(0, count).map((item) => item.id);
}

/** «The Morning After» answers. */
export const MORNING_AFTER_ANSWERS = ["great", "pass"] as const;
export type MorningAfterAnswer = (typeof MORNING_AFTER_ANSWERS)[number];

export function isMorningAfterAnswer(value: unknown): value is MorningAfterAnswer {
  return (
    typeof value === "string" && (MORNING_AFTER_ANSWERS as readonly string[]).includes(value)
  );
}

/** Local hour the morning check is sent at (the brief: 11:00–12:00). */
export const MORNING_AFTER_HOUR = 11;
/**
 * Latest local hour the check may still go out when the 11:00 tick was missed
 * (a deploy, a down host). Past it the moment is gone and nothing is sent.
 */
export const MORNING_AFTER_LATEST_HOUR = 14;
/**
 * The check goes to the first local 11:00 at least this long after the date —
 * a lunch date at 12:00 is asked the NEXT morning, not an hour later.
 */
export const MORNING_AFTER_MIN_GAP_MS = 6 * 60 * 60 * 1000;
/** A date older than this is not asked about at all. */
export const MORNING_AFTER_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/**
 * How long after mutual interest the offer (flowers hint + cheat sheet) is
 * shown on «Сегодня». The sheet itself stays open forever once unlocked.
 */
export const MUTUAL_OFFER_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;
