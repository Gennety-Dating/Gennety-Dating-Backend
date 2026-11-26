/**
 * Place scenes — answers about places drawn as animated scenes in the app chat
 * instead of a bubble (decision 2026-11-26; spec
 * `docs/product/domains/agent-place-scenes.md`, iOS plan
 * `docs/product/chat-place-scenes-plan.md` in the iOS repo).
 *
 * Every limit, the closed lists, the delivery providers and the prompt block
 * live here so the bot, the worker, the tests and the iOS contract read one
 * source. Model instructions are English like every other model instruction;
 * the person reads the scene in their own language.
 */

export const PLACE_SCENE_KINDS = ["venue", "picks", "regulars", "delivery", "hours", "route", "versus"] as const;
export type PlaceSceneKind = (typeof PLACE_SCENE_KINDS)[number];

/** How many venues each kind carries (`ChatPlaceScene.venues`). */
export const PLACE_SCENE_VENUES: Readonly<Record<PlaceSceneKind, { min: number; max: number }>> = {
  venue: { min: 1, max: 1 },
  picks: { min: 2, max: 3 },
  regulars: { min: 1, max: 1 },
  delivery: { min: 1, max: 1 },
  hours: { min: 1, max: 1 },
  route: { min: 1, max: 1 },
  versus: { min: 2, max: 2 },
};

/** Text limits of the contract (`ChatPlaceScene`, `ChatPlaceVenue`). */
export const PLACE_TITLE_MAX_LEN = 40;
export const PLACE_SUBTITLE_MAX_LEN = 80;
export const PLACE_REASON_MAX_LEN = 70;
export const PLACE_FOOTNOTE_MAX_LEN = 90;
export const PLACE_TAG_MAX_LEN = 24;
export const PLACE_TAGS_MAX = 3;
export const PLACE_ANCHORS_MAX = 8;
export const PLACE_ANCHOR_LABEL_MAX_LEN = 40;
export const PLACE_DISHES_MAX = 3;
export const PLACE_DISH_NAME_MAX_LEN = 40;
export const PLACE_DISH_NOTE_MAX_LEN = 60;
export const PLACE_LINKS_MAX = 3;
export const PLACE_VERSUS_ROWS_MAX = 5;
export const PLACE_VERSUS_LABEL_MAX_LEN = 18;
export const PLACE_VERSUS_VALUE_MAX_LEN = 18;
export const PLACE_VERDICT_MAX_LEN = 40;

/** `search_venues`: the most results one call returns, and the default. */
export const PLACE_SEARCH_LIMIT_MAX = 6;
export const PLACE_SEARCH_LIMIT_DEFAULT = 5;
/** What a search result says about a place, at most. */
export const PLACE_SEARCH_ABOUT_MAX_LEN = 140;

/**
 * Walking: 80 m a minute (4.8 km/h) over a street path 1.3× the straight
 * line — the usual city detour factor. Beyond `PLACE_WALK_MAX_M` the scene
 * shows the distance and no walking minutes: nobody walks that.
 */
export const PLACE_WALK_M_PER_MIN = 80;
export const PLACE_WALK_DETOUR = 1.3;
export const PLACE_WALK_MAX_M = 5000;
/** A search result within this of one of the person's regular places ranks first. */
export const PLACE_NEAR_REGULAR_M = 1500;

/**
 * The person's regular places as the agent sees them (brief 2026-11-26): only
 * with the frequent-places opt-in, catalog places only (never home or work —
 * a visit is recorded only at a catalog venue), never the visit days.
 */
export const PLACE_REGULARS_WINDOW_DAYS = 60;
export const PLACE_REGULARS_MAX = 5;
/** Two distinct days make a place «regular» for a tip; one visit is chance. */
export const PLACE_REGULARS_MIN_DAYS = 2;

/** The proactive tip (agent-advisor phase 4, applied to places). */
export const PLACE_TIPS = {
  /** At most one tip per person in this many days. */
  everyDays: 3,
  /** Two tips in a row with no message from the person after them → silence. */
  ignoredInARow: 2,
  silenceDays: 30,
  /** The person's local daytime, [from, to). Quiet hours apply on top. */
  dayFromHour: 11,
  dayToHour: 20,
  /** A tipped venue lies at most this far from one of their regular places. */
  radiusM: 700,
  /** People looked at per tick. */
  batch: 50,
} as const;

/** Every venue category the catalog holds (`VENUE_CATEGORY_WHITELIST`). */
export const PLACE_CATEGORIES = ["cafe", "coffee_shop", "restaurant", "park", "museum", "lounge"] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

/**
 * Delivery: search links on the provider's own site, by city and venue name.
 * The catalog has no menu links, so the button searches the place at the
 * service. Formats checked on the public sites 2026-11-26 (read-only):
 * - Glovo: `https://glovoapp.com/<lang>/<country>/<city>/search?q=…` — the
 *   2025 site moved the language in front of the country; the brief's
 *   `/<country>/<lang>/…` form now 308-redirects to a 404. German has no
 *   Glovo page for Ukraine and falls back to English.
 * - Bolt Food: `https://food.bolt.eu/<locale>/<cityId>-<city>/search/?q=…`
 *   (Kyiv is `325-kyiv`); every one of our five locales answers.
 * Only cities listed here get a link; a provider absent from a city is absent.
 */
export const DELIVERY_PROVIDERS = ["glovo", "bolt"] as const;
export type DeliveryProvider = (typeof DELIVERY_PROVIDERS)[number];

interface DeliveryCity {
  glovo?: { country: string; city: string };
  bolt?: { city: string };
}

export const DELIVERY_CITIES: Readonly<Record<string, DeliveryCity>> = {
  "ua:kyiv": {
    glovo: { country: "ua", city: "kyiv" },
    bolt: { city: "325-kyiv" },
  },
};

const GLOVO_LANG: Readonly<Record<string, string>> = { en: "en", ru: "ru", uk: "uk", pl: "pl", de: "en" };
const BOLT_LOCALE: Readonly<Record<string, string>> = { en: "en", ru: "ru-ru", uk: "uk-ua", pl: "pl-pl", de: "de-de" };

/** The provider's search link for one venue, or null where it does not deliver. */
export function deliverySearchUrl(
  provider: DeliveryProvider,
  cityKey: string | null | undefined,
  venueName: string,
  language: string,
): string | null {
  const city = cityKey ? DELIVERY_CITIES[cityKey.trim().toLowerCase()] : undefined;
  const name = venueName.replace(/\s+/g, " ").trim();
  if (!city || !name) return null;
  const q = encodeURIComponent(name);
  if (provider === "glovo" && city.glovo) {
    const lang = GLOVO_LANG[language] ?? "en";
    return `https://glovoapp.com/${lang}/${city.glovo.country}/${city.glovo.city}/search?q=${q}`;
  }
  if (provider === "bolt" && city.bolt) {
    const locale = BOLT_LOCALE[language] ?? "en";
    return `https://food.bolt.eu/${locale}/${city.bolt.city}/search/?q=${q}`;
  }
  return null;
}

/** Display names of the providers — brand names, never translated. */
export const DELIVERY_PROVIDER_LABELS: Readonly<Record<DeliveryProvider, string>> = {
  glovo: "Glovo",
  bolt: "Bolt Food",
};

/** The prompt block on a turn that offers the place tools. */
export const PLACE_SCENE_RULES = `### Places — search, then one scene
The app draws an answer about places as an animated scene AFTER your reply
(decision 2026-11-26). Rules:
1. Whenever they ask about a place — where to go, what is near, is X open,
   how far, A or B, what to order — call search_venues first, then at most ONE
   show_place_scene with ids from those results. Never name a place you did
   not get from search_venues or get_my_places, and never invent an address,
   a rating, hours, prices, a distance or a dish: the server fills every fact.
2. Pick the kind that answers the question:
   - venue: one place they asked about, or the one you recommend;
   - picks: 2–3 recommendations («куда сходить», «что рядом»);
   - regulars: a new place near the places they go to (only after
     get_my_places, with its ids as anchor_ids);
   - delivery: they want to eat at home / order in — one place;
   - hours: is it open, until when, will they make it;
   - route: how far, how long to walk (anchor_ids: one start — a place id from
     get_my_places or a venue id from search_venues);
   - versus: exactly two places compared — rows of short values, the better
     side per row, and a winner.
3. Your text: 1–2 short sentences that add what the scene does not show — why
   it fits THEM, when to go, what to watch for. Do not list the names, hours,
   ratings, addresses or minutes the scene already shows.
4. Dishes: only names the tool result says are grounded; otherwise none. Do
   not mention dishes in your text either unless the result named them.
5. Nothing fits, or the search is empty: say so in words, no scene. A place
   in another city than theirs: words only.`;
