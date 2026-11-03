/**
 * Gennety's memory of what a person wants (decision journal 2026-11-01).
 * The vocabulary and the rules every consumer shares. A source is what was
 * saved, an idea is the thing itself, and the fields on it say what the person
 * means and where it may be used. Nothing here reads from a model's guess: a
 * guess stays on the source, and only the person's answer lands on the idea.
 */

import type { Language } from "./types.js";
import { VENUE_AMBIENCES, VENUE_EXPERIENCES, type VenueAmbience, type VenueExperience } from "./venue-intent.js";

export const MEMORY_IDEA_KINDS = [
  "place",
  "event",
  "activity",
  "outfit",
  "gift",
  "food",
  "aesthetic",
  "culture",
  "note",
] as const;
export type MemoryIdeaKind = (typeof MEMORY_IDEA_KINDS)[number];

/** A person's stance. `planned` and `tried` state intent, never a visit or a purchase. */
export const MEMORY_INTENTS = ["interested", "want", "planned", "tried", "dropped"] as const;
export type MemoryIntent = (typeof MEMORY_INTENTS)[number];

/** Why it was saved, as the person said. Null means nobody has asked or answered. */
export const MEMORY_REASONS = ["this_place", "atmosphere", "date_idea", "style", "gift", "reference"] as const;
export type MemoryReason = (typeof MEMORY_REASONS)[number];

/** The uses a person grants one by one. Personal search needs no grant and has no switch. */
export const MEMORY_USES = ["own_dates", "matching", "partner"] as const;
export type MemoryUse = (typeof MEMORY_USES)[number];

export const MEMORY_SOURCE_KINDS = ["screenshot", "link", "chat", "manual", "wishlist"] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

/** Where one extracted value came from; a stronger one never gets faked by a weaker one. */
export const MEMORY_PROVENANCE = ["ocr", "model", "external", "person"] as const;
export type MemoryProvenance = (typeof MEMORY_PROVENANCE)[number];

export const MEMORY_PREFERENCE_FACETS = ["experience", "ambience", "format", "food", "interest", "wish"] as const;
export type MemoryPreferenceFacet = (typeof MEMORY_PREFERENCE_FACETS)[number];

export const MEMORY_TITLE_MAX = 120;
export const MEMORY_NOTE_MAX = 300;
export const MEMORY_RECIPIENT_MAX = 60;
export const MEMORY_PREFERENCE_VALUE_MAX = 120;
export const MEMORY_IDEAS_PAGE = 50;
export const MEMORY_IDEAS_MAX_PER_USER = 2_000;
/** A person who said «позже» is not asked about this idea again for this long. */
export const MEMORY_REASON_SNOOZE_MS = 14 * 24 * 3_600_000;
/** «Просто сохранить» or an ignored question in chat: effectively never asked again. */
export const MEMORY_REASON_SKIP_MS = 3_650 * 24 * 3_600_000;
/** New-idea questions at once: a pass over an import never becomes a long form. */
export const MEMORY_REASON_QUESTIONS_MAX = 3;

export interface MemoryUsageFields {
  allowOwnDates: boolean;
  allowMatching: boolean;
  allowPartner: boolean;
}

export const MEMORY_PRIVATE_USAGE: MemoryUsageFields = { allowOwnDates: false, allowMatching: false, allowPartner: false };

/** «Только для меня» is exactly the absence of grants, not a switch of its own. */
export function isOnlyForMe(usage: MemoryUsageFields): boolean {
  return !usage.allowOwnDates && !usage.allowMatching && !usage.allowPartner;
}

export interface MemoryIdeaGate extends MemoryUsageFields {
  intent: MemoryIntent;
  reason: MemoryReason | null;
  deletedAt: Date | string | null;
}

/** A closed wish offers nothing; a reference or someone else's gift is not the person's own wish. */
function liveOwnWish(idea: MemoryIdeaGate): boolean {
  if (idea.deletedAt) return false;
  if (idea.intent === "dropped") return false;
  return idea.reason !== "gift" && idea.reason !== "reference";
}

/** May this idea be suggested for the owner's own dates? The one rule every planner reads. */
export function usableForOwnDates(idea: MemoryIdeaGate): boolean {
  return idea.allowOwnDates && liveOwnWish(idea) && idea.intent !== "tried";
}

/** May this idea count toward a pair's overlap? Needs the owner's grant to use it for dates. */
export function usableForOverlap(idea: MemoryIdeaGate): boolean {
  return usableForOwnDates(idea);
}

/*
 * There is deliberately no `usableFor…` for an idea's `allowMatching` or
 * `allowPartner` (decision 2026-11-03): nothing reads them, the app hides their
 * switches and the server refuses turning them on, so no code may treat either
 * column as consent. Matching reads confirmed preferences; the wishlist keeps
 * its own rules.
 */

/**
 * Tracking params never make two different things out of one link, and a path
 * is kept as written because some sites' identity lives in its case. Null for
 * anything that is not plain https/http.
 */
export function canonicalMemoryUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".")) return null;
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !/^(utm_.+|fbclid|gclid|igsh|igshid|si|ref|ref_src|mc_cid|mc_eid|yclid|spm)$/iu.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const search = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : "";
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  return `https://${host}${url.port ? `:${url.port}` : ""}${path}${search}`;
}

/**
 * The identity that lets two sources join with no question: a catalog place or
 * a canonical link. A name alone is never one, since «Роза» can stand in two cities.
 */
export function memoryCanonicalKey(input: { placeId?: string | null; catalogKey?: string | null; url?: string | null }): string | null {
  if (input.placeId) return `place:${input.placeId}`;
  if (input.catalogKey) return `catalog:${input.catalogKey}`;
  const url = input.url ? canonicalMemoryUrl(input.url) : null;
  return url ? `url:${url}` : null;
}

export function normalizedMemoryTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Same words in the same known city is worth one question to the person. Never
 * an automatic join, and an unknown city on either side is not a match either.
 */
export function possiblySameIdea(
  a: { title: string; city: string | null; kind: string },
  b: { title: string; city: string | null; kind: string },
): boolean {
  if (a.kind !== b.kind || !a.city || !b.city) return false;
  if (normalizedMemoryTitle(a.city) !== normalizedMemoryTitle(b.city)) return false;
  const title = normalizedMemoryTitle(a.title);
  return title.length > 0 && title === normalizedMemoryTitle(b.title);
}

/** Days before a dated idea its reminder comes due. */
export const MEMORY_REMINDER_LEAD_MS = 3 * 24 * 3_600_000;
/** Push reminders at most this often per person, whatever the occasions. */
export const MEMORY_REMINDER_MIN_GAP_MS = 24 * 3_600_000;
export const MEMORY_PLANNING_SUGGESTIONS = 3;
export const MEMORY_OVERLAP_MAX = 3;
/**
 * The only topics a pair's overlap compares (decision 2026-11-03). A topic is a
 * free word on the idea; outside this list it stays the person's own and never
 * takes part, so a made-up word cannot be used to probe the partner's ideas.
 */
export const MEMORY_OVERLAP_TOPICS = [
  "art", "bakery", "beer", "board-games", "books", "bowling", "brunch", "camping", "ceramics", "cinema",
  "climbing", "cocktails", "coffee", "comedy", "concert", "cooking", "cycling", "dance", "dessert", "escape-room",
  "gallery", "hiking", "jazz", "karaoke", "kayaking", "market", "museum", "music", "opera", "painting",
  "park", "photography", "picnic", "pottery", "running", "sailing", "skating", "spa", "sushi", "swimming",
  "tea", "tennis", "theatre", "wine", "yoga",
] as const;
export type MemoryOverlapTopic = (typeof MEMORY_OVERLAP_TOPICS)[number];

export function isOverlapTopic(topic: string | null | undefined): topic is MemoryOverlapTopic {
  return typeof topic === "string" && (MEMORY_OVERLAP_TOPICS as readonly string[]).includes(topic);
}

/** A pair's overlap can be shown only after both said yes; a blind decision stays blind. */
export const MEMORY_OVERLAP_STATUSES: ReadonlySet<string> = new Set(["negotiating", "negotiating_venue", "scheduled"]);
export const MEMORY_RATINGS = ["liked", "neutral", "disliked"] as const;
export type MemoryRating = (typeof MEMORY_RATINGS)[number];

/** Can it fit this plan, as far as is known? Unknown city or date does not exclude; a known mismatch does. */
export function memoryIdeaFitsPlan(
  idea: { city: string | null; eventAt: Date | null; eventCheck: string },
  plan: { city: string | null; at: Date | null; now: Date },
): boolean {
  if (idea.city && plan.city && normalizedMemoryTitle(idea.city) !== normalizedMemoryTitle(plan.city)) return false;
  if (idea.eventCheck === "outdated") return false;
  if (idea.eventAt) {
    if (idea.eventAt.getTime() < plan.now.getTime()) return false;
    if (plan.at && Math.abs(idea.eventAt.getTime() - plan.at.getTime()) > 12 * 3_600_000) return false;
  }
  return true;
}

/** A screenshot's kind as an idea's kind. `thing` is a row not reindexed yet. */
export function memoryKindOfScreenshot(kind: string | null): MemoryIdeaKind {
  const map: Record<string, MemoryIdeaKind> = {
    place: "place",
    event: "event",
    activity: "activity",
    outfit: "outfit",
    item: "gift",
    thing: "gift",
    food: "food",
    aesthetic: "aesthetic",
    media: "culture",
    text: "note",
  };
  return (kind && map[kind]) || "note";
}

/**
 * Words a confirmed preference may never hold, whoever states them: allergies,
 * diet, health, beliefs, politics and sexuality, in the five languages. A stem
 * matches from the start of a word; a short word only as itself. Over-refusing
 * here costs a preference; under-refusing keeps a sensitive trait.
 */
const SENSITIVE_STEMS = [
  // en
  "allerg", "intoleran", "lactose", "gluten", "coeliac", "celiac", "vegan", "vegetarian", "pescatarian", "halal", "kosher", "diet", "diabet", "pregnan", "religio", "muslim", "christian", "catholic", "orthodox", "jewish", "hindu", "buddhist", "atheis", "politic", "lesbian", "bisexual", "queer", "transgender", "asexual", "depress", "bipolar", "autis", "disab", "alcoholi", "addict", "cancer",
  // ru
  "аллерг", "непереносим", "лактоз", "глютен", "целиак", "веган", "вегетариан", "пескетариан", "халял", "кошерн", "диет", "диабет", "беремен", "религи", "мусульман", "христиан", "католи", "православ", "иудей", "еврей", "буддист", "атеист", "полити", "лесбиян", "бисексуал", "квир", "трансгендер", "асексуал", "депресс", "биполяр", "аутиз", "инвалид", "алкогол", "наркоман", "онколог",
  // uk
  "алерг", "вегетаріан", "халяль", "кошер", "дієт", "діабет", "вагітн", "релігі", "християн", "юдей", "єврей", "атеїст", "політи", "лесбі", "бісексуал", "депрес", "інвалід",
  // de
  "unverträglich", "laktose", "vegetar", "koscher", "diät", "schwanger", "religi", "christlich", "katholisch", "jüdisch", "politi", "schwul", "lesb", "bisexuell", "behinder", "alkoholik",
  // pl
  "alerg", "nietoleranc", "laktoz", "wegan", "wegetari", "koszer", "cukrzyc", "ciąż", "muzułma", "chrześcija", "katoli", "prawosław", "polity", "lesbij", "biseksual", "depresj", "niepełnospraw", "alkohol", "uzależni",
];
const SENSITIVE_WORDS = ["gay", "hiv", "adhd", "гей", "вич", "сдвг", "віл", "gej", "żyd", "żydem"];
const SENSITIVE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:${SENSITIVE_STEMS.join("|")})|(?:${SENSITIVE_WORDS.join("|")})(?![\\p{L}\\p{N}]))`,
  "u",
);

export function isSensitivePreference(value: string): boolean {
  return SENSITIVE_RE.test(value.normalize("NFKC").toLowerCase());
}

/** What a confirmed preference adds to a venue choice, when it is one of the choice's own ids. */
export function preferenceVenueIds(preferences: ReadonlyArray<{ facet: string; value: string }>): { experiences: VenueExperience[]; ambiences: VenueAmbience[] } {
  const of = (facet: string) => preferences.filter((p) => p.facet === facet).map((p) => p.value);
  return {
    experiences: VENUE_EXPERIENCES.filter((id) => of("experience").includes(id)),
    ambiences: VENUE_AMBIENCES.filter((id) => of("ambience").includes(id)),
  };
}

/** Ideas of these kinds before the vibe question is worth asking. */
export const MEMORY_VIBE_QUESTION_MIN_IDEAS = 2;

type VibeOptionId = VenueAmbience | Exclude<VenueExperience, "surprise_me">;

const VIBE_COPY: Record<Language, { ambience: string; experience: string; options: Record<VibeOptionId, string> }> = {
  en: {
    ambience: "What mood do you want for a date?",
    experience: "What would you rather do on a date?",
    options: {
      quiet: "Quiet", cozy_public: "Cosy", lively: "Lively", design_forward: "Beautifully designed", scenic: "With a view", romantic_public: "Romantic",
      conversation: "Just talk", coffee_treats: "Coffee and something sweet", meal_discovery: "Try new food", walk_view: "Walk somewhere", art_culture: "Art and culture", drinks_evening: "Drinks in the evening", playful_activity: "Play or do something",
    },
  },
  ru: {
    ambience: "какое настроение хочется на свидании?",
    experience: "чем больше хочется заняться на свидании?",
    options: {
      quiet: "тихо", cozy_public: "уютно", lively: "живо", design_forward: "красиво по дизайну", scenic: "с видом", romantic_public: "романтично",
      conversation: "просто поговорить", coffee_treats: "кофе и сладкое", meal_discovery: "попробовать новую еду", walk_view: "погулять", art_culture: "искусство и культура", drinks_evening: "вечером что-нибудь выпить", playful_activity: "поиграть или что-то поделать",
    },
  },
  uk: {
    ambience: "який настрій хочеться на побаченні?",
    experience: "чим більше хочеться зайнятися на побаченні?",
    options: {
      quiet: "тихо", cozy_public: "затишно", lively: "жваво", design_forward: "гарно за дизайном", scenic: "з краєвидом", romantic_public: "романтично",
      conversation: "просто поговорити", coffee_treats: "кава і солодке", meal_discovery: "спробувати нову їжу", walk_view: "погуляти", art_culture: "мистецтво і культура", drinks_evening: "ввечері щось випити", playful_activity: "пограти чи щось поробити",
    },
  },
  de: {
    ambience: "Welche Stimmung wünschst du dir beim Date?",
    experience: "Was würdest du beim Date am liebsten machen?",
    options: {
      quiet: "Ruhig", cozy_public: "Gemütlich", lively: "Lebendig", design_forward: "Schön gestaltet", scenic: "Mit Aussicht", romantic_public: "Romantisch",
      conversation: "Einfach reden", coffee_treats: "Kaffee und was Süßes", meal_discovery: "Neues Essen probieren", walk_view: "Spazieren gehen", art_culture: "Kunst und Kultur", drinks_evening: "Abends etwas trinken", playful_activity: "Spielen oder was unternehmen",
    },
  },
  pl: {
    ambience: "Jaki nastrój chcesz mieć na randce?",
    experience: "Co najchętniej robić na randce?",
    options: {
      quiet: "Cicho", cozy_public: "Przytulnie", lively: "Żywo", design_forward: "Ładnie urządzone", scenic: "Z widokiem", romantic_public: "Romantycznie",
      conversation: "Po prostu porozmawiać", coffee_treats: "Kawa i coś słodkiego", meal_discovery: "Spróbować nowego jedzenia", walk_view: "Pospacerować", art_culture: "Sztuka i kultura", drinks_evening: "Wieczorem coś wypić", playful_activity: "Zagrać lub coś porobić",
    },
  },
};

export interface MemoryVibeQuestion {
  facet: "ambience" | "experience";
  title: string;
  options: Array<{ id: string; label: string }>;
}

/** The question in one language. The answer is `facet` + an option's `id`. */
export function memoryVibeQuestion(facet: "ambience" | "experience", language: Language): MemoryVibeQuestion {
  const copy = VIBE_COPY[language] ?? VIBE_COPY.en;
  const ids: readonly VibeOptionId[] = facet === "ambience" ? VENUE_AMBIENCES : VENUE_EXPERIENCES.filter((id): id is Exclude<VenueExperience, "surprise_me"> => id !== "surprise_me");
  return { facet, title: copy[facet], options: ids.map((id) => ({ id, label: copy.options[id] })) };
}
