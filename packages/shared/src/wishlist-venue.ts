import {
  mapVibeTagsToFacets,
  type VenueAmbience,
  type VenueExperience,
  type VenueFormat,
} from "./venue-intent.js";
import { wishlistCatalogItem } from "./wishlist-catalog.js";

/**
 * The wishlist as a SOFT hint for the first venue (decision journal
 * 2026-10-15, founder: «подсказывать место свидания по вишлисту»).
 *
 * What a person put on their list — a rooftop bar, natural wine, matcha, a
 * botanical garden, or the name of a café they love — says what kind of place
 * would please them. It never decides the venue: it becomes a draw weight
 * INSIDE the diversity band (`venue-diversity.ts`), next to Tempo Sync's, so it
 * can only choose between venues the ranker already rates near-equal and can
 * never pull a worse one past a clear winner. It is never logged, never stored
 * on the match and never reaches the venue blurb or the selection reason — the
 * partner must not be able to read a list they were not shown.
 *
 * Only `place`, `drink` and `experience` items speak to a venue; a perfume or
 * flowers do not. Catalog ideas carry curated tags; free text («негрони»,
 * «крыша с видом») goes through a small multilingual keyword map.
 */

/** Item categories that say something about a place. */
const VENUE_CATEGORIES = new Set(["place", "drink", "experience"]);

/**
 * Free-text words → venue vibe tags (`mapVibeTagsToFacets` vocabulary). Kept
 * deliberately short and unambiguous; a miss costs nothing (neutral).
 */
const KEYWORD_TAGS: Array<[RegExp, readonly string[]]> = [
  [/coffee|кофе|кав[аиу]|kaffee|kawa|flat ?white|флэт|латте|latte|капучино|cappuccino|espresso|эспрессо/iu, ["coffee"]],
  [/matcha|матч[аи]|\btea\b|\bчай|\bчаю|herbat|\btee\b/iu, ["tea"]],
  [/wine|вин[оа]|вине|wein|wino|natural|натурал/iu, ["wine"]],
  [/cocktail|коктейл|negroni|негрони|aperol|апероль|spritz|шприц|martini|мартини|margarita|маргарит/iu, ["cocktail"]],
  [/\bbeer\b|пив[оа]|\bbier\b|piwo|craft|крафт/iu, ["beer"]],
  [/rooftop|крыш|дах[уі]?|\bdach|panoram|панорам|вид на/iu, ["rooftop", "view"]],
  [/book|книж|книг|книгарн|buch|księgar|ksiazk/iu, ["books"]],
  [/garden|сад|ботанич|park|парк|ogród|ogrod/iu, ["garden"]],
  [/museum|музе|galler|галере|виставк|выставк|ausstellung|wystaw|\bart\b/iu, ["art"]],
  [/jazz|джаз|vinyl|винил|вініл|live music|живая музыка|жива музика/iu, ["vinyl", "lively"]],
  [/sushi|суши|ramen|рамен|pasta|паст[аи]|pizza|пицц|піц|dinner|ужин|вечер[яю]|kolacj/iu, ["dinner"]],
  [/dessert|десерт|croissant|круассан|bakery|пекарн|выпечк|випічк|cake|торт|tiramisu|тирамису/iu, ["dessert"]],
  [/brunch|бранч|breakfast|завтрак|сніданок|frühstück|śniadan/iu, ["brunch"]],
  [/sunset|закат|захід|sonnenuntergang|zachód|zachod|river|рек[аиу]|рiчк|набережн|\bwater\b|море|sea/iu, ["view", "water"]],
  [/quiet|тих[оийа]|спокойн|cozy|уютн|затишн|gemütlich|przytuln/iu, ["cozy", "quiet"]],
];

export interface WishlistVenueTaste {
  experiences: ReadonlySet<VenueExperience>;
  ambiences: ReadonlySet<VenueAmbience>;
  formats: ReadonlySet<VenueFormat>;
  /** Folded names of `place` items — a direct hit on a venue of that name. */
  placeNames: ReadonlySet<string>;
}

export interface WishlistVenueItem {
  category: string;
  title: string;
  brand: string | null;
  catalogKey: string | null;
}

/** Lower-case letters and digits only — "Kanapa Café" and "kanapa cafe!" meet. */
export function foldVenueName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** What a list says about places; null when nothing on it does. */
export function wishlistVenueTaste(items: readonly WishlistVenueItem[]): WishlistVenueTaste | null {
  const tags: string[] = [];
  const placeNames = new Set<string>();
  for (const item of items) {
    if (!VENUE_CATEGORIES.has(item.category)) continue;
    const catalog = item.catalogKey ? wishlistCatalogItem(item.catalogKey) : undefined;
    if (catalog) {
      tags.push(...catalog.tags);
      continue;
    }
    const text = [item.brand, item.title].filter(Boolean).join(" ");
    for (const [pattern, mapped] of KEYWORD_TAGS) if (pattern.test(text)) tags.push(...mapped);
    // A searched or typed place is most likely a real venue's name.
    if (item.category === "place") {
      const folded = foldVenueName(item.title);
      if (folded.length >= 3) placeNames.add(folded);
    }
  }
  const facets = mapVibeTagsToFacets(tags);
  if (facets.experiences.length + facets.ambiences.length + facets.formats.length === 0 && placeNames.size === 0) {
    return null;
  }
  return {
    experiences: new Set(facets.experiences),
    ambiences: new Set(facets.ambiences),
    formats: new Set(facets.formats),
    placeNames,
  };
}

/**
 * How well one venue fits one person's list, 0…1, 0.5 = no opinion. A venue
 * whose name is on their list is a 1; otherwise each axis that has an opinion
 * counts the share of its facets the venue has, and a venue that has none of
 * them sits a little below neutral — never far: a list is a hint, not a veto.
 */
export function wishlistVenueFit(
  taste: WishlistVenueTaste | null,
  venue: {
    name: string;
    facets: { experiences: readonly string[]; ambiences: readonly string[]; formats: readonly string[] };
  },
): number {
  if (!taste) return 0.5;
  if (taste.placeNames.size > 0) {
    const name = foldVenueName(venue.name);
    for (const wanted of taste.placeNames) {
      if (name === wanted || (wanted.length >= 5 && name.includes(wanted))) return 1;
    }
  }
  const axes: Array<[ReadonlySet<string>, readonly string[]]> = [
    [taste.experiences, venue.facets.experiences],
    [taste.ambiences, venue.facets.ambiences],
    [taste.formats, venue.facets.formats],
  ];
  let opinions = 0;
  let hit = 0;
  for (const [wanted, has] of axes) {
    if (wanted.size === 0) continue;
    opinions += 1;
    if (has.some((id) => wanted.has(id))) hit += 1;
  }
  if (opinions === 0) return 0.5;
  // 0 hits → 0.4, every axis hit → 0.9.
  return 0.4 + 0.5 * (hit / opinions);
}

/**
 * The pair's in-band draw weight: the mean of both fits, centred on 1 like
 * `venueTier2Multiplier`. `weight` 0 (the default) switches it off; it is
 * capped at 0.5 so a hint can at most triple a near-tie's odds, never more.
 */
export function wishlistVenueMultiplier(fitA: number, fitB: number, weight: number): number {
  const w = !Number.isFinite(weight) || weight <= 0 ? 0 : Math.min(weight, 0.5);
  if (w === 0) return 1;
  const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);
  const fit = (clamp(fitA) + clamp(fitB)) / 2;
  return 1 + w * (2 * fit - 1);
}
