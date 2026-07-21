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
  softModifiers?: string[];
}

export interface VenueScoreBreakdown {
  userFitA: number;
  userFitB: number;
  pairFit: number;
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

function coverage(wanted: readonly string[], actual: readonly string[]): number {
  if (wanted.length === 0 || wanted.includes("surprise_me")) return 1;
  return wanted.filter((value) => actual.includes(value)).length / wanted.length;
}

function userFit(intent: VenueIntentV2, candidate: VenueRankCandidate): number {
  const experience = coverage(intent.experiences, candidate.facets.experiences);
  const ambience = coverage(intent.ambiences, candidate.facets.ambiences);
  const format = coverage(intent.formats, candidate.facets.formats);
  const modifiers = candidate.softModifiers?.length ? Math.min(1, candidate.softModifiers.length / 2) : 0.5;
  return 0.4 * experience + 0.25 * ambience + 0.15 * format + 0.2 * modifiers;
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
): VenueScoreBreakdown | null {
  const commuteLimit = Math.min(a.hardConstraints.maxCommuteKm, b.hardConstraints.maxCommuteKm);
  if (Math.max(candidate.distanceA, candidate.distanceB) > commuteLimit) return null;
  if (Math.abs(candidate.distanceA - candidate.distanceB) > 3) return null;
  if (!satisfiesVenueHardConstraints(a, candidate) || !satisfiesVenueHardConstraints(b, candidate)) return null;
  const userFitA = userFit(a, candidate);
  const userFitB = userFit(b, candidate);
  const pairFit = 0.6 * Math.min(userFitA, userFitB) + 0.4 * ((userFitA + userFitB) / 2);
  const commuteFairness = Math.max(0, 1 - Math.abs(candidate.distanceA - candidate.distanceB) / 3);
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

export function rankVenueCandidates(
  candidates: VenueRankCandidate[],
  a: VenueIntentV2,
  b: VenueIntentV2,
): Array<{ candidate: VenueRankCandidate; score: VenueScoreBreakdown }> {
  return candidates
    .map((candidate) => ({ candidate, score: scoreVenueCandidate(candidate, a, b) }))
    .filter((row): row is { candidate: VenueRankCandidate; score: VenueScoreBreakdown } => row.score !== null)
    .sort((left, right) =>
      right.score.finalScore - left.score.finalScore ||
      left.candidate.priority - right.candidate.priority ||
      (right.candidate.reviews ?? 0) - (left.candidate.reviews ?? 0) ||
      left.candidate.placeId.localeCompare(right.candidate.placeId),
    );
}
