export const VENUE_INTENT_PARSER_VERSION = "venue-intent-v2" as const;
export const VENUE_SELECTION_VERSION = "venue-ranker-v2" as const;

export const VENUE_EXPERIENCES = [
  "conversation",
  "coffee_treats",
  "meal_discovery",
  "walk_view",
  "art_culture",
  "drinks_evening",
  "playful_activity",
  "surprise_me",
] as const;

export const VENUE_AMBIENCES = [
  "quiet",
  "cozy_public",
  "lively",
  "design_forward",
  "scenic",
  "romantic_public",
] as const;

export const VENUE_FORMATS = [
  "seated",
  "walking",
  "interactive",
  "indoor",
  "outdoor",
] as const;

export const VENUE_DIETARY_CONSTRAINTS = [
  "vegan",
  "vegetarian",
  "halal",
  "kosher",
  "gluten_free",
] as const;

export const VENUE_PRICE_LIMITS = ["free", "inexpensive", "moderate"] as const;

export type VenueExperience = (typeof VENUE_EXPERIENCES)[number];
export type VenueAmbience = (typeof VENUE_AMBIENCES)[number];
export type VenueFormat = (typeof VENUE_FORMATS)[number];
export type VenueDietaryConstraint = (typeof VENUE_DIETARY_CONSTRAINTS)[number];
export type VenuePriceLimit = (typeof VENUE_PRICE_LIMITS)[number];
export type VenueIntentState = "draft" | "confirmed";

export interface VenueHardConstraints {
  dietary: VenueDietaryConstraint[];
  alcoholFree: boolean;
  stepFree: boolean;
  setting: "indoor" | "outdoor" | null;
  maxPrice: VenuePriceLimit | null;
  maxCommuteKm: 8 | 12;
}

export interface VenueIntentOrigin {
  lat: number;
  lng: number;
  address: string | null;
}

export interface VenueIntentV2 {
  rawText: string;
  experiences: VenueExperience[];
  ambiences: VenueAmbience[];
  formats: VenueFormat[];
  /** Parser output before the user edits chips; retained only as structured IDs. */
  interpretedFacets?: {
    experiences: VenueExperience[];
    ambiences: VenueAmbience[];
    formats: VenueFormat[];
  };
  hardConstraints: VenueHardConstraints;
  parserConfidence: number;
  parserVersion: typeof VENUE_INTENT_PARSER_VERSION;
  state: VenueIntentState;
  origin: VenueIntentOrigin | null;
  interpretedAt: string;
  confirmedAt: string | null;
  manualConfirmationRequired: boolean;
}

export interface VenueCandidateFacets {
  experiences: VenueExperience[];
  ambiences: VenueAmbience[];
  formats: VenueFormat[];
  dietary: VenueDietaryConstraint[];
  alcoholFree: boolean | null;
  stepFree: boolean | null;
  setting: "indoor" | "outdoor" | "both" | null;
  price: VenuePriceLimit | "expensive" | null;
}

export interface VenueRankCandidate {
  id: string;
  placeId: string;
  priority: number;
  rating: number | null;
  reviews: number | null;
  evidenceConfidence: number;
  distanceA: number;
  distanceB: number;
  facets: VenueCandidateFacets;
  /**
   * Reserved, **not scored**. No producer has ever populated it, so scoring it
   * meant adding the same constant to every candidate (see `userFit`). Kept on
   * the type for compatibility; wire it into `userFit` only once something
   * actually writes it.
   */
  softModifiers?: string[];
}

export interface VenueScoreBreakdown {
  userFitA: number;
  userFitB: number;
  pairFit: number;
  /**
   * Commute component = fairness x proximity (`commuteScore`). Keeps its
   * historical name so `venue_selection_logs` rows stay comparable, but it is
   * no longer fairness alone — a balanced-but-distant venue now scores below a
   * balanced-and-near one.
   */
  commuteFairness: number;
  venueQuality: number;
  evidenceConfidence: number;
  finalScore: number;
}

export type VenueBridgeLane =
  | "direct"
  | "coffee_scenic_walk"
  | "gallery_bookstore_cafe"
  | "food_near_promenade"
  | "listening_gallery_bar"
  | "activity_with_refreshments"
  | "max_min_fit"
  | "surprise_best_unseen";

const EXPERIENCE_SET = new Set<string>(VENUE_EXPERIENCES);
const AMBIENCE_SET = new Set<string>(VENUE_AMBIENCES);
const FORMAT_SET = new Set<string>(VENUE_FORMATS);
const DIETARY_SET = new Set<string>(VENUE_DIETARY_CONSTRAINTS);
const PRICE_SET = new Set<string>(VENUE_PRICE_LIMITS);

function canonicalList<T extends string>(value: unknown, allowed: Set<string>, max: number): T[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is T => typeof item === "string" && allowed.has(item)))].slice(0, max);
}

export function defaultVenueHardConstraints(): VenueHardConstraints {
  return {
    dietary: [],
    alcoholFree: false,
    stepFree: false,
    setting: null,
    maxPrice: null,
    maxCommuteKm: 8,
  };
}

export function normalizeVenueIntent(input: VenueIntentV2): VenueIntentV2 {
  const hard = input.hardConstraints ?? defaultVenueHardConstraints();
  return {
    ...input,
    rawText: input.rawText.trim().slice(0, 500),
    experiences: canonicalList<VenueExperience>(input.experiences, EXPERIENCE_SET, 3),
    ambiences: canonicalList<VenueAmbience>(input.ambiences, AMBIENCE_SET, 3),
    formats: canonicalList<VenueFormat>(input.formats, FORMAT_SET, 3),
    ...(input.interpretedFacets ? {
      interpretedFacets: {
        experiences: canonicalList<VenueExperience>(input.interpretedFacets.experiences, EXPERIENCE_SET, 3),
        ambiences: canonicalList<VenueAmbience>(input.interpretedFacets.ambiences, AMBIENCE_SET, 3),
        formats: canonicalList<VenueFormat>(input.interpretedFacets.formats, FORMAT_SET, 3),
      },
    } : {}),
    hardConstraints: {
      dietary: canonicalList<VenueDietaryConstraint>(hard.dietary, DIETARY_SET, 5),
      alcoholFree: hard.alcoholFree === true,
      stepFree: hard.stepFree === true,
      setting: hard.setting === "indoor" || hard.setting === "outdoor" ? hard.setting : null,
      maxPrice: typeof hard.maxPrice === "string" && PRICE_SET.has(hard.maxPrice) ? hard.maxPrice : null,
      maxCommuteKm: hard.maxCommuteKm === 12 ? 12 : 8,
    },
    parserConfidence: Math.max(0, Math.min(1, Number(input.parserConfidence) || 0)),
    parserVersion: VENUE_INTENT_PARSER_VERSION,
  };
}

/**
 * Operator `vibeTags` → canonical facet ids.
 *
 * The curated catalog carries a 67-word free-text vocabulary written by hand
 * (`coffee`, `wine`, `books`, `rooftop`, …) on 100% of its rows, and the V2
 * selector ignored all of it — candidate facets were derived from `category`
 * alone, which is why eight experiences collapsed onto six categories. This is
 * the translation layer.
 *
 * Deliberately partial: a tag only appears here when its canonical meaning is
 * unambiguous. Purely locational (`podil`, `central`, `campus`), stylistic
 * (`casual`, `classic`, `upscale`) and dietary-adjacent (`hearty`, `raw`) tags
 * map to nothing rather than being forced into the nearest id.
 */
const VIBE_TAG_FACETS: Record<string, readonly string[]> = Object.assign(Object.create(null), {
  // experiences
  coffee: ["coffee_treats"], roastery: ["coffee_treats"], specialty: ["coffee_treats"],
  tea: ["coffee_treats"], dessert: ["coffee_treats"], bakery: ["coffee_treats"],
  brunch: ["coffee_treats"], breakfast: ["coffee_treats"], sourdough: ["coffee_treats"],
  dinner: ["meal_discovery"], pizza: ["meal_discovery"], pasta: ["meal_discovery"],
  sushi: ["meal_discovery"], ramen: ["meal_discovery"], seafood: ["meal_discovery"],
  meat: ["meal_discovery"], asian: ["meal_discovery"], chinese: ["meal_discovery"],
  japanese: ["meal_discovery"], vietnamese: ["meal_discovery"], italian: ["meal_discovery"],
  french: ["meal_discovery"], ukrainian: ["meal_discovery"], gastro: ["meal_discovery"],
  walk: ["walk_view", "walking"], view: ["walk_view", "scenic"], nature: ["walk_view", "scenic"],
  garden: ["walk_view", "scenic", "outdoor"], water: ["walk_view", "scenic"],
  culture: ["art_culture"], art: ["art_culture"], history: ["art_culture"],
  science: ["art_culture"], books: ["art_culture"], architecture: ["art_culture"],
  wine: ["drinks_evening"], cocktail: ["drinks_evening"], drinks: ["drinks_evening"],
  beer: ["drinks_evening"], evening: ["drinks_evening"],
  interactive: ["playful_activity", "interactive"], fun: ["playful_activity"],
  conversation: ["conversation"],
  // ambiences
  cozy: ["cozy_public"], quiet: ["quiet"], study: ["quiet"], lively: ["lively"],
  romantic: ["romantic_public"], design: ["design_forward"], modern: ["design_forward"],
  retro: ["design_forward"], vinyl: ["design_forward"], rooftop: ["scenic"],
  // formats
  outdoor: ["outdoor"], terrace: ["outdoor"],
  // Null-prototype on purpose: a plain object literal would resolve
  // `VIBE_TAG_FACETS["constructor"]` (or "toString", "__proto__", …) to an
  // inherited member, which is truthy — so `?? []` would not catch it and the
  // `for…of` below would throw on a curated venue that happened to carry such
  // a tag, taking down venue selection for that pair.
});

/**
 * Translate operator vibe tags into canonical facet ids, split by axis.
 * Unknown tags are dropped. Exported so the catalog seeder and the selector
 * share one definition.
 */
export function mapVibeTagsToFacets(tags: readonly string[]): {
  experiences: VenueExperience[];
  ambiences: VenueAmbience[];
  formats: VenueFormat[];
} {
  const hits = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const mapped = VIBE_TAG_FACETS[tag.trim().toLowerCase()];
    if (!Array.isArray(mapped)) continue;
    for (const id of mapped) hits.add(id);
  }
  return {
    experiences: VENUE_EXPERIENCES.filter((id) => hits.has(id)),
    ambiences: VENUE_AMBIENCES.filter((id) => hits.has(id)),
    formats: VENUE_FORMATS.filter((id) => hits.has(id)),
  };
}

export function isConfirmedVenueIntent(value: unknown): value is VenueIntentV2 {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<VenueIntentV2>;
  return intent.parserVersion === VENUE_INTENT_PARSER_VERSION && intent.state === "confirmed" && !!intent.origin;
}

export function legacyVibeToVenueIntent(
  vibe: "coffee" | "walk" | "drinks" | "study",
  origin: VenueIntentOrigin,
  now = new Date(),
): VenueIntentV2 {
  const mapped: Record<typeof vibe, Pick<VenueIntentV2, "experiences" | "ambiences" | "formats">> = {
    coffee: { experiences: ["coffee_treats"], ambiences: [], formats: ["seated", "indoor"] },
    walk: { experiences: ["walk_view"], ambiences: ["scenic"], formats: ["walking", "outdoor"] },
    drinks: { experiences: ["drinks_evening"], ambiences: ["lively"], formats: ["seated", "indoor"] },
    study: { experiences: ["conversation"], ambiences: ["quiet"], formats: ["seated", "indoor"] },
  };
  const iso = now.toISOString();
  return {
    rawText: vibe,
    ...mapped[vibe],
    hardConstraints: defaultVenueHardConstraints(),
    parserConfidence: 1,
    parserVersion: VENUE_INTENT_PARSER_VERSION,
    state: "confirmed",
    origin,
    interpretedAt: iso,
    confirmedAt: iso,
    manualConfirmationRequired: false,
  };
}

function has(intent: VenueIntentV2, value: VenueExperience): boolean {
  return intent.experiences.includes(value);
}

export function resolveVenueBridge(a: VenueIntentV2, b: VenueIntentV2): VenueBridgeLane[] {
  const explicitA = a.experiences.filter((value) => value !== "surprise_me");
  const explicitB = b.experiences.filter((value) => value !== "surprise_me");
  if (explicitA.some((value) => explicitB.includes(value))) return ["direct"];
  if (explicitA.length === 0 && explicitB.length === 0) return ["surprise_best_unseen"];
  if (explicitA.length === 0 || explicitB.length === 0) return ["direct"];

  const lanes: VenueBridgeLane[] = [];
  const pair = (x: VenueExperience, y: VenueExperience): boolean =>
    (has(a, x) && has(b, y)) || (has(a, y) && has(b, x));
  if (pair("coffee_treats", "walk_view")) lanes.push("coffee_scenic_walk");
  if (pair("coffee_treats", "art_culture")) lanes.push("gallery_bookstore_cafe");
  if (pair("meal_discovery", "walk_view")) lanes.push("food_near_promenade");
  if (pair("drinks_evening", "art_culture")) lanes.push("listening_gallery_bar");
  if (
    (has(a, "playful_activity") && b.experiences.some((x) => ["coffee_treats", "meal_discovery", "drinks_evening"].includes(x))) ||
    (has(b, "playful_activity") && a.experiences.some((x) => ["coffee_treats", "meal_discovery", "drinks_evening"].includes(x)))
  ) lanes.push("activity_with_refreshments");
  if (lanes.length === 0) lanes.push("max_min_fit");
  return lanes.slice(0, 3);
}

/**
 * Partial credit between two facets of the same axis, symmetric, 0..1.
 *
 * Exact-match-only coverage (the previous behaviour) collapsed the catalog into
 * a few enormous equivalence classes: a venue either carried the exact id the
 * user picked or scored a flat zero, so most candidates tied and the ranking
 * fell through to rating. These pairs are deliberately conservative — an exact
 * match still scores 1.0, so partial credit only ever separates venues that
 * used to be indistinguishable at zero. Opposites (quiet/lively,
 * indoor/outdoor) are absent on purpose: they must stay at 0.
 */
const FACET_AFFINITY: Record<string, number> = {};
function affinity(a: string, b: string, weight: number): void {
  FACET_AFFINITY[`${a}|${b}`] = weight;
  FACET_AFFINITY[`${b}|${a}`] = weight;
}
// Ambience neighbourhoods.
affinity("quiet", "cozy_public", 0.6);
affinity("cozy_public", "romantic_public", 0.6);
affinity("scenic", "romantic_public", 0.4);
affinity("quiet", "scenic", 0.3);
affinity("design_forward", "romantic_public", 0.3);
affinity("design_forward", "lively", 0.3);
// Experience neighbourhoods — "where can you actually talk" drives these.
affinity("conversation", "coffee_treats", 0.6);
affinity("conversation", "meal_discovery", 0.5);
affinity("conversation", "drinks_evening", 0.4);
affinity("conversation", "art_culture", 0.3);
affinity("coffee_treats", "meal_discovery", 0.4);
affinity("meal_discovery", "drinks_evening", 0.4);
affinity("walk_view", "art_culture", 0.3);
// Format neighbourhoods.
affinity("seated", "indoor", 0.5);
affinity("walking", "outdoor", 0.6);

/**
 * How well `actual` covers `wanted`, averaged over the wanted facets, with each
 * one credited by its best match (exact 1.0, adjacent per `FACET_AFFINITY`).
 */
function coverage(wanted: readonly string[], actual: readonly string[]): number {
  if (wanted.length === 0 || wanted.includes("surprise_me")) return 1;
  let total = 0;
  for (const want of wanted) {
    let best = 0;
    for (const have of actual) {
      const score = have === want ? 1 : (FACET_AFFINITY[`${want}|${have}`] ?? 0);
      if (score > best) best = score;
    }
    total += best;
  }
  return total / wanted.length;
}

/**
 * How well one participant's stated intent is met by a candidate.
 *
 * `softModifiers` is deliberately NOT scored: nothing in the codebase has ever
 * populated it, so the old `modifiers` term resolved to the literal 0.5 for
 * every candidate — a flat 0.1 added to all of them, i.e. 20% of this score
 * spent on a constant that could not discriminate between two venues. Dropping
 * it and renormalising the three real dimensions also widens the usable range
 * from [0.1, 0.9] to [0, 1], so genuinely different venues separate further.
 */
function userFit(intent: VenueIntentV2, candidate: VenueRankCandidate): number {
  const experience = coverage(intent.experiences, candidate.facets.experiences);
  const ambience = coverage(intent.ambiences, candidate.facets.ambiences);
  const format = coverage(intent.formats, candidate.facets.formats);
  return 0.5 * experience + 0.3 * ambience + 0.2 * format;
}

/** Worst-commute decay: 1.0 at the doorstep, `PROXIMITY_FLOOR` at the limit. */
const PROXIMITY_FLOOR = 0.4;

/** Default cap on |distA − distB| — the venue must be roughly fair to both. */
export const VENUE_FAIRNESS_DELTA_KM = 3;

/**
 * How far the geometry is allowed to stretch on one ranking pass.
 *
 * Both numbers were hardcoded until 2026-08-05, which made the venue step fail
 * outright for a pair whose departure points were simply far apart — legal
 * input inside one city, and a dead end that cost them the date (PRODUCT_SPEC
 * §3.7). The selector now retries with progressively wider tolerances instead;
 * these are the knobs it turns, and NOTHING ELSE relaxes with them — quality,
 * hours, price policy and hard constraints are identical on every pass.
 */
export interface VenueGeoTolerance {
  /** Hard cap on the worse of the two commutes (km). */
  commuteLimitKm: number;
  /** Hard cap on the difference between the two commutes (km). */
  fairnessDeltaKm: number;
}

/** The pair's own stated tolerance — the first and usual rung. */
export function defaultVenueGeoTolerance(a: VenueIntentV2, b: VenueIntentV2): VenueGeoTolerance {
  return {
    commuteLimitKm: Math.min(a.hardConstraints.maxCommuteKm, b.hardConstraints.maxCommuteKm),
    fairnessDeltaKm: VENUE_FAIRNESS_DELTA_KM,
  };
}

/**
 * Commute score = fairness x proximity.
 *
 * Fairness alone (the previous behaviour) only asked "are the two commutes
 * equal?", so a venue 7.9 km from both scored a perfect 1.0 exactly like one
 * 300 m from both. Since the pair's own coordinates entered the score nowhere
 * else, the ranking was effectively location-blind and the same central venues
 * kept winning for everyone. Proximity restores the half that was missing.
 *
 * Both scales follow the active tolerance rather than being fixed, so a widened
 * pass still discriminates: at a 60 km limit a venue 5 km from both must still
 * outrank one 40 km from one of them. Freezing the scales at the tight defaults
 * would flatten every far candidate to the same floor and hand the decision
 * entirely to fit — exactly when commute matters most.
 */
function commuteScore(candidate: VenueRankCandidate, tolerance: VenueGeoTolerance): number {
  const imbalance = Math.abs(candidate.distanceA - candidate.distanceB);
  const fairness = Math.max(0, 1 - imbalance / Math.max(tolerance.fairnessDeltaKm, 0.001));
  const worst = Math.max(candidate.distanceA, candidate.distanceB);
  const proximity = Math.max(
    PROXIMITY_FLOOR,
    1 - (worst / Math.max(tolerance.commuteLimitKm, 0.001)) * (1 - PROXIMITY_FLOOR),
  );
  return fairness * proximity;
}

const PRICE_ORDER: Record<VenueCandidateFacets["price"] & string, number> = {
  free: 0,
  inexpensive: 1,
  moderate: 2,
  expensive: 3,
};

export function satisfiesVenueHardConstraints(intent: VenueIntentV2, candidate: VenueRankCandidate): boolean {
  const hard = intent.hardConstraints;
  if (hard.dietary.some((diet) => !candidate.facets.dietary.includes(diet))) return false;
  if (hard.alcoholFree && candidate.facets.alcoholFree !== true) return false;
  if (hard.stepFree && candidate.facets.stepFree !== true) return false;
  if (hard.setting && candidate.facets.setting !== hard.setting && candidate.facets.setting !== "both") return false;
  if (hard.maxPrice) {
    if (candidate.facets.price == null) return false;
    if (PRICE_ORDER[candidate.facets.price] > PRICE_ORDER[hard.maxPrice]) return false;
  }
  return true;
}

export function scoreVenueCandidate(
  candidate: VenueRankCandidate,
  a: VenueIntentV2,
  b: VenueIntentV2,
  tolerance: VenueGeoTolerance = defaultVenueGeoTolerance(a, b),
): VenueScoreBreakdown | null {
  if (Math.max(candidate.distanceA, candidate.distanceB) > tolerance.commuteLimitKm) return null;
  if (Math.abs(candidate.distanceA - candidate.distanceB) > tolerance.fairnessDeltaKm) return null;
  if (!satisfiesVenueHardConstraints(a, candidate) || !satisfiesVenueHardConstraints(b, candidate)) return null;
  const userFitA = userFit(a, candidate);
  const userFitB = userFit(b, candidate);
  const pairFit = 0.6 * Math.min(userFitA, userFitB) + 0.4 * ((userFitA + userFitB) / 2);
  const commuteFairness = commuteScore(candidate, tolerance);
  const rating = candidate.rating == null ? 0.5 : Math.max(0, Math.min(1, (candidate.rating - 3) / 2));
  const reviews = candidate.reviews == null ? 0.5 : Math.min(1, Math.log10(candidate.reviews + 1) / 4);
  const priority = Math.max(0, Math.min(1, (4 - candidate.priority) / 3));
  const venueQuality = 0.5 * rating + 0.3 * reviews + 0.2 * priority;
  const evidenceConfidence = Math.max(0, Math.min(1, candidate.evidenceConfidence));
  return {
    userFitA,
    userFitB,
    pairFit,
    commuteFairness,
    venueQuality,
    evidenceConfidence,
    finalScore: 0.55 * pairFit + 0.2 * commuteFairness + 0.15 * venueQuality + 0.1 * evidenceConfidence,
  };
}

// ---------------------------------------------------------------------------
// Season + weather (VENUE_ENGINE_IMPROVEMENT_PLAN 5.3)
// ---------------------------------------------------------------------------
// A park in a downpour is a worse date than the same park in June, and the
// engine had no way to know that. The product decision (founder, 2026-07-31)
// is that this NEVER removes a venue — it only sinks it a few places among
// options the ranker already considers comparable. The reason is stated
// plainly: a forecast can be wrong, a provider can be down, and neither is
// allowed to withhold a venue from a couple. That is the same principle the
// catalog already applies to unknown opening hours (unknown → treated as open,
// never as a reason to exclude).
//
// Everything here is pure. The forecast fetch lives in the bot service so this
// module stays free of I/O and is exhaustively testable.

/** How exposed a venue is to the weather. `unknown` always scores neutral. */
export type VenueExposure = "indoor" | "outdoor" | "mixed" | "unknown";

export interface VenueWeatherSnapshot {
  /** 0..100. */
  precipitationProbabilityPct: number;
  temperatureC: number;
  /** Thunderstorm, hail, heavy snow — a categorical "not today, outdoors". */
  isSevere: boolean;
}

/**
 * Hard bounds on the combined season × weather multiplier.
 *
 * Deliberately a code constant rather than an env knob: this is the guarantee
 * that context can never outrank fit or quality (founder requirement T4), not
 * a tuning dial. At the floor a venue loses a fifth of its score, which
 * reorders near-ties and nothing else.
 */
export const VENUE_CONTEXT_MULTIPLIER_MIN = 0.8;
export const VENUE_CONTEXT_MULTIPLIER_MAX = 1.1;

/** Northern-hemisphere seasons; Kyiv is the only launched market (§1.3). */
function seasonOf(month: number): "winter" | "summer" | "shoulder" {
  if (month === 12 || month === 1 || month === 2) return "winter";
  if (month >= 6 && month <= 8) return "summer";
  return "shoulder";
}

/**
 * Calendar-only relevance. Costs nothing and cannot fail, so it keeps working
 * when the forecast does not.
 *
 * Spring and autumn are deliberately neutral: in Kyiv they are the seasons
 * where the calendar genuinely predicts nothing and the actual weather is the
 * only real signal.
 *
 * @param month 1..12
 */
export function seasonalRelevance(
  exposure: VenueExposure,
  ambiences: readonly string[],
  month: number,
): number {
  if (exposure === "indoor" || exposure === "unknown") return 1;
  const season = seasonOf(month);
  if (season === "shoulder") return 1;
  const scenic = ambiences.includes("scenic");
  if (season === "winter") return exposure === "outdoor" ? 0.9 : 0.95;
  // Summer. A scenic outdoor spot is the best version of the season, so it
  // gets the amplifier; a plain outdoor one still gains, just less.
  const base = exposure === "outdoor" ? 1.05 : 1.02;
  return scenic ? base * 1.03 : base;
}

/**
 * Forecast-driven relevance. A null snapshot means "we could not find out",
 * which scores exactly like perfect weather — never like bad weather. Any
 * other reading of a failed lookup would let an outage quietly delete the
 * outdoor half of the catalog.
 */
export function weatherRelevanceMultiplier(
  exposure: VenueExposure,
  ambiences: readonly string[],
  weather: VenueWeatherSnapshot | null,
): number {
  if (!weather) return 1;
  if (exposure === "indoor" || exposure === "unknown") return 1;

  let multiplier = 1;
  if (weather.isSevere || weather.precipitationProbabilityPct >= 50) multiplier *= 0.85;
  if (weather.temperatureC < 5 || weather.temperatureC > 32) multiplier *= 0.9;

  const pleasant =
    !weather.isSevere &&
    weather.precipitationProbabilityPct < 20 &&
    weather.temperatureC >= 10 &&
    weather.temperatureC <= 28;
  if (pleasant) multiplier *= ambiences.includes("scenic") ? 1.05 : 1.03;

  return multiplier;
}

/**
 * The value the ranker actually multiplies by: season × weather, clamped.
 *
 * The clamp is the whole safety story. Both inputs are individually mild, but
 * they compound, and without a bound a cold severe winter day could stack to
 * ~0.69 — enough to push a genuinely better venue below a worse one, which is
 * exactly the trade T4 forbids.
 */
export function venueContextMultiplier(
  exposure: VenueExposure,
  ambiences: readonly string[],
  month: number,
  weather: VenueWeatherSnapshot | null,
): number {
  const combined =
    seasonalRelevance(exposure, ambiences, month) *
    weatherRelevanceMultiplier(exposure, ambiences, weather);
  return Math.min(VENUE_CONTEXT_MULTIPLIER_MAX, Math.max(VENUE_CONTEXT_MULTIPLIER_MIN, combined));
}

/**
 * Resolve exposure from what the catalog actually knows.
 *
 * `facets.setting` is the authoritative signal, but it is only populated for
 * rows the facet backfill has run over, so a hand-added park can carry null.
 * Category is the fallback for exactly that case and ONLY for parks, where the
 * category alone settles it — a null setting on a restaurant genuinely means
 * unknown, and guessing "indoor" there would be inventing evidence.
 */
export function venueExposureOf(
  setting: VenueCandidateFacets["setting"],
  category: string | null,
): VenueExposure {
  if (setting === "both") return "mixed";
  if (setting === "indoor" || setting === "outdoor") return setting;
  return category === "park" ? "outdoor" : "unknown";
}

export function rankVenueCandidates(
  candidates: VenueRankCandidate[],
  a: VenueIntentV2,
  b: VenueIntentV2,
  tolerance: VenueGeoTolerance = defaultVenueGeoTolerance(a, b),
): Array<{ candidate: VenueRankCandidate; score: VenueScoreBreakdown }> {
  return candidates
    .map((candidate) => ({ candidate, score: scoreVenueCandidate(candidate, a, b, tolerance) }))
    .filter((row): row is { candidate: VenueRankCandidate; score: VenueScoreBreakdown } => row.score !== null)
    .sort((left, right) =>
      right.score.finalScore - left.score.finalScore ||
      left.candidate.priority - right.candidate.priority ||
      (right.candidate.reviews ?? 0) - (left.candidate.reviews ?? 0) ||
      left.candidate.placeId.localeCompare(right.candidate.placeId),
    );
}
