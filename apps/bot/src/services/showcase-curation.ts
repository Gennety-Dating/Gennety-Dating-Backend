/**
 * What the standby showcase (the iOS city guide) is allowed to show — the
 * founder's call of 2026-09-22, kept apart from the selection mechanics in
 * `curated-venue.ts` because it is editorial data, not logic.
 *
 * The brief: the default map is a map of the city's places — no radius, no
 * query, no filter — but every place at once is noise, so it shows the city's
 * best: the premium catalog first, then the fashionable, beautiful places,
 * the iconic parks, a couple of the most popular cafés. Never the Georgian,
 * Crimean-Tatar or Uzbek kitchens, plov or shawarma — those stay on the
 * venue-change board, where the operator already filed most of them
 * (`tier: "alternative"`, board-only).
 *
 * "Fashionable" is taste, and no column holds it: the first draft derived it
 * from facet and vibe tags, and the founder then struck two of its places and
 * brought back nine it had cut. So a city with a hand-picked list shows exactly
 * that list, and the rule below only speaks for a city that has none.
 */

/** One hand-picked place: the Google place id is the key, the name is for the reader. */
export interface ShowcasePick {
  placeId: string;
  name: string;
}

/**
 * The hand-picked showcase per city, in the founder's order — the first entry
 * is where the walk starts, i.e. the first card. Keyed by Google place id
 * because the catalog holds a row per university domain and the name alone is
 * ambiguous for a chain (eight Idealist Coffee rows, one pick).
 *
 * A pick the catalog no longer has active (the nightly re-validation closed it)
 * simply drops out; a list none of whose ids resolve falls back to the rule, so
 * a stale list can never empty the map. Keep it within `SHOWCASE_LIMIT`.
 *
 * Kyiv, 2026-09-22: every premium place except the two Georgian kitchens
 * (Чічіко, Кувшин) and La Coupole — that row was Google's Paris La Coupole,
 * mis-resolved into the Kyiv catalog, and was removed from it the same day
 * (the Kyiv place it meant is Купол, listed); then the base places the founder kept or
 * brought back, the most popular Idealist Coffee and five parks.
 */
export const SHOWCASE_PICKS: Readonly<Record<string, readonly ShowcasePick[]>> = {
  "ua:kyiv": [
    // Premium catalog.
    { placeId: "ChIJj5MtLVjO1EARO1QyBhuU79U", name: "Кафе Fandom" },
    { placeId: "ChIJu_dWOfDO1EARKsm_xtCOO_g", name: "Favorite Uncle" },
    { placeId: "ChIJh4zct2rO1EARV6qSAAuLU-Y", name: "Win Bar" },
    { placeId: "ChIJhalizqnP1EAReP85e7Ckmn8", name: "Biggoli" },
    { placeId: "ChIJX4dpWHvO1EARPMfnxsa7cCs", name: "VINO e CUCINA" },
    { placeId: "ChIJO1kBW_7O1EARY-p6E-TsY04", name: "BEEF meat&wine" },
    { placeId: "ChIJud7obz_O1EARvvaO3Gl5BUk", name: "Vero Vero" },
    { placeId: "ChIJ38FRLAfP1EARxPwOz5ylfjY", name: "BAO Modern Chinese Cuisine" },
    { placeId: "ChIJdXIBUfzO1EARWHFVG97WzMM", name: "NAM" },
    { placeId: "ChIJu0wQo2nO1EAR64H_rvAPURI", name: "Oxota na Ovets" },
    { placeId: "ChIJESt9sljP1EARBFD_tyn-rT8", name: "Італійська Редакція" },
    { placeId: "ChIJEzB7aT3P1EAR6HPkRP8d0nw", name: "Fish&Pussycat Sushi Bar" },
    { placeId: "ChIJOaEBw-zO1EARrRgeY1j1DCU", name: "Semifreddo" },
    { placeId: "ChIJ_1OYiqrP1EAR9QHwuIzPZ5M", name: "La Veranda Restaurant & Garden" },
    { placeId: "ChIJ38h3N_XO1EAROmiNSMLS-bY", name: "Piccolino" },
    { placeId: "ChIJrfRtGUHO1EARtwvpjV2nK1Q", name: "Casa Nori" },
    { placeId: "ChIJ95ClDVjO1EARZxFUI5Yi5lo", name: "Citronelle" },
    { placeId: "ChIJCT8LqyfP1EAR0OvPuoTt7ko", name: "11 Mirrors Restaurant & Bar" },
    { placeId: "ChIJrX1QmYTP1EARwo1gg9RYh_k", name: "Японський Привіт" },
    { placeId: "ChIJFf1HDl3P1EARZH3FZawwBJI", name: "Бути Sofie" },
    { placeId: "ChIJnwP4sETO1EARIT8t_OC3vZM", name: "Catch Seafood Restaurant" },
    { placeId: "ChIJmwWDTgfP1EARab2RAvhE788", name: "Lucky Restaurant Vinotheque" },
    { placeId: "ChIJdVfCZfbO1EARlHtJzjyiTW0", name: "Park Kitchen" },
    { placeId: "ChIJJRd2gnvP1EAReCDYDT-s7UA", name: "AVANGARDEN gallery and wine bar" },
    { placeId: "ChIJs9KLLAHP1EARAXg11su0JkI", name: "Cafe Marko" },
    { placeId: "ChIJX31WnQ_P1EARPNcar64s3Ps", name: "Grill do Brasil" },
    { placeId: "ChIJ5Yz1ZwfP1EARSNjYL9MgxvA", name: "SHO" },
    { placeId: "ChIJw8BMp-TO1EARa6rEcrFvVX0", name: "Sam's Steak House" },
    { placeId: "ChIJ6ZKeqVnO1EARYnOXe-r0swY", name: "Très Branché" },
    { placeId: "ChIJJ87ob9_P1EARKV3IR4C3uFA", name: "SARTO" },
    { placeId: "ChIJ-QcdtZLP1EARDdqpFJHIuW4", name: "Ink Липки" },
    { placeId: "ChIJV4Y-G6DP1EARHDP4LKundhA", name: "Купол" },
    { placeId: "ChIJuTx6kYXP1EAR3r6cBZ7cYoE", name: "Good Girl" },
    { placeId: "ChIJwUwWslLP1EARUVjRrPtPzNI", name: "Mirali" },
    { placeId: "ChIJKYK2Xm3P1EAREj1aU0yDQ8s", name: "Bassano Ristorante" },
    { placeId: "ChIJffwA-vnO1EARkYTZdSJJjPM", name: "Ресторан MARIO" },
    { placeId: "ChIJI6bN8ULP1EARcXPQNy6dFsk", name: "Vicini Italiani" },
    { placeId: "ChIJ6UuhaQDP1EARGmF8hD1UFrw", name: "Steakhouse" },
    { placeId: "ChIJIaYEbQDP1EARmi6K2-meTrQ", name: "Elevato" },
    { placeId: "ChIJ-2SifnjP1EARoOX6vivIIW4", name: "Frou Frou" },
    { placeId: "ChIJzwdw7RLP1EARQCg6rI3Hz7k", name: "Porto Maltese" },
    // Fashionable base places.
    { placeId: "ChIJ3_H8OFDO1EAR6SeTa5GIJYg", name: "Éclair Little Artwork" },
    { placeId: "ChIJM7oDHV7P1EAROolLz6ZFUrQ", name: "Passenger Gastro Bar" },
    { placeId: "ChIJwaRXnDLP1EARXVg-qFN4KWA", name: "Сімона" },
    { placeId: "ChIJ_5oCh4zP1EARGOYCZLiG_Xw", name: "100 rokiv tomu vpered" },
    { placeId: "ChIJY0Qe_QDP1EARRu5WyS2lK04", name: "BARVY" },
    { placeId: "ChIJBb6RWZnP1EARM0pecqvoFlM", name: "Hey Guys" },
    { placeId: "ChIJb45VZ5jP1EARH-EQG5dSDS8", name: "Coffee Records" },
    { placeId: "ChIJq6pq3ADP1EARczzWH8kOv5c", name: "Blur Coffee" },
    { placeId: "ChIJZZjzMlbO1EAREY6IYK_ghvA", name: "ZMIST Театральна" },
    { placeId: "ChIJSbIQ_2bP1EARqgdNu2ybkF8", name: "Pure & Naive" },
    { placeId: "ChIJC5Am6VzO1EARKrr5cUF6qQw", name: "Kosatka" },
    { placeId: "ChIJAQCEW1HO1EARc9GXgU-Uv0U", name: "PAUL (Велика Васильківська, 32)" },
    { placeId: "ChIJ5dSpugbP1EARD_9ZvJ150h8", name: "Buffalino" },
    { placeId: "ChIJ87hEd2fP1EAREidDScA3ydY", name: "Suite13" },
    // The most popular.
    { placeId: "ChIJU44X9f7O1EARf8FPJSie660", name: "Milk Bar" },
    { placeId: "ChIJSbtwSrfP1EARvAwgoJbDPrQ", name: "Idealist Coffee (Ярославів Вал, 15)" },
    // Parks.
    { placeId: "ChIJiT4uj0XO1EARGZx_Gnd3y2A", name: "Володимирська Гірка" },
    { placeId: "ChIJ8RD5zEPO1EARlkMnW0tP4YY", name: "Андріївський узвіз" },
    { placeId: "ChIJ50j3KqzP1EARjDA3fn8hQ1A", name: "Маріїнський парк" },
    { placeId: "ChIJoUUJqfnO1EARfD--thVh3RA", name: "Парк Шевченка" },
    { placeId: "ChIJc30u3PbO1EARtA0u0Ui1DG0", name: "Ботанічний сад ім. Фоміна" },
  ],
};

/**
 * Tiers the rule never shows. `alternative` is the board-only tier — by the
 * operator's own filing it is where the Georgian, Crimean-Tatar and pan-Asian
 * kitchens the founder struck already live.
 */
export const SHOWCASE_EXCLUDED_TIERS: readonly string[] = ["alternative"];

/**
 * Google primary types the rule never shows. In the Kyiv catalog Google files
 * the Georgian kitchens as `eastern_european_restaurant` (Чічіко, Кувшин, Mama
 * Gochi, Georgia, Sanatrelo) and the Uzbek/Tatar ones as `halal_restaurant`.
 */
export const SHOWCASE_EXCLUDED_PRIMARY_TYPES: readonly string[] = [
  "eastern_european_restaurant",
  "halal_restaurant",
  "middle_eastern_restaurant",
  "turkish_restaurant",
  "lebanese_restaurant",
  "afghani_restaurant",
  "kebab_shop",
  "fast_food_restaurant",
  "meal_delivery",
];

/**
 * Name fragments the rule never shows — for the kitchens Google files under a
 * plain `restaurant` (Шоті is Georgian and typed as nothing more).
 */
export const SHOWCASE_EXCLUDED_NAME_FRAGMENTS: readonly string[] = [
  "грузин", "georgia", "хачапур", "khachapur", "хінкал", "хинкал", "khinkal", "шоті",
  "узбек", "uzbek", "самарканд", "чайхан", "chaikhan", "плов", "plov",
  "татар", "tatar", "крим", "crimea", "чебурек", "cheburek",
  "шаурм", "шаверм", "shawarm", "shaurm", "кебаб", "kebab", "донер", "doner",
];

/** True when the rule must leave this place out as a kitchen the founder struck. */
export function isShowcaseExcludedKitchen(place: { name: string; primaryType: string | null }): boolean {
  if (place.primaryType && SHOWCASE_EXCLUDED_PRIMARY_TYPES.includes(place.primaryType)) return true;
  const name = place.name.toLocaleLowerCase();
  return SHOWCASE_EXCLUDED_NAME_FRAGMENTS.some((fragment) => name.includes(fragment));
}

/** Words that name the kind of place, not the brand. */
const BRAND_GENERIC_WORDS = new Set([
  "cafe", "café", "кафе", "кав'ярня", "kav'yarnya", "ресторан", "restaurant", "the",
  "park", "парк", "сквер", "skver",
]);

/**
 * A place's brand, for "one card per brand": eleven branches of one pie shop
 * would otherwise be eleven cards of the same photo. Parenthesised branch notes
 * and kind-of-place words are dropped; a short first word ("One", "Very",
 * "Milk") takes the second one with it so "ONE LOVE" and "One Tea Tree" stay
 * two brands. A false merge costs one card, never a wrong one.
 */
export function showcaseBrandKey(name: string): string {
  const bare = name
    .toLocaleLowerCase()
    .replace(/[ʼ’`]/gu, "'")
    .replace(/\(.*?\)/gu, " ");
  const words = bare.split(/[\s•|,.\-"«»]+/u).filter(Boolean);
  const meaningful = words.filter((word) => !BRAND_GENERIC_WORDS.has(word));
  const tokens = meaningful.length > 0 ? meaningful : words;
  if (tokens.length === 0) return bare.trim();
  return tokens[0].length <= 4 && tokens.length > 1 ? `${tokens[0]} ${tokens[1]}` : tokens[0];
}
