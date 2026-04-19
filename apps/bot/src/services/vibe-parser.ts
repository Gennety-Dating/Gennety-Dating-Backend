/**
 * Vibe parser — concierge venue safety layer (Phase 3.4).
 *
 * Users type a free-form "vibe" (e.g. "nice cafe with vegan options",
 * "quiet park walk"). Before any of that touches Google Places we MUST:
 *   1. drop anything that suggests a private / intimate / unsafe setting
 *      (hotels, saunas, a user's apartment, etc.) — this is a hard
 *      product constraint, not a UX nicety,
 *   2. force the result onto a strict whitelist of public-accessible
 *      Places categories.
 *
 * Two layers of defence:
 *   - a deterministic deny-list regex runs FIRST and catches the obvious
 *     cases without spending an LLM call. Belt-and-braces: if the LLM is
 *     down / returns nonsense, the hardcoded safety floor still holds.
 *   - an LLM JSON call refines the category and extracts search keywords.
 *     Any LLM output that falls outside the whitelist is overridden to
 *     the safe default `"cafe"`.
 */

import { callOpenAIJson } from "./openai.js";

/**
 * Whitelisted Places categories. Anything else the LLM returns is coerced
 * to `cafe`. Priority order used by `mergeParsed` (left = safer / more
 * public) when the two users disagree.
 */
export const VENUE_CATEGORY_WHITELIST = [
  "cafe",
  "coffee_shop",
  "restaurant",
  "park",
  "museum",
  "lounge",
] as const;

export type VenueCategory = (typeof VENUE_CATEGORY_WHITELIST)[number];

const DEFAULT_CATEGORY: VenueCategory = "cafe";

/**
 * Deterministic deny-list of intimate / private / unsafe venue types.
 * These terms trigger an unconditional override BEFORE the LLM is called,
 * so an outage or prompt-injection attempt cannot leak them through.
 */
const DENY_PATTERNS: RegExp[] = [
  /\bhotel(s)?\b/i,
  /\bmotel(s)?\b/i,
  /\bhostel(s)?\b/i,
  /\bairbnb\b/i,
  /\bsauna(s)?\b/i,
  /\bbanya\b/i,
  /\bbath\s*house\b/i,
  /\bbathhouse\b/i,
  /\bspa\b/i,
  /\bmassage\b/i,
  /\bstrip(\s?club)?\b/i,
  /\bbrothel\b/i,
  /\bpool\s*(party|hall)?\b/i,
  /\bmy\s+(place|home|apartment|flat|dorm|room)\b/i,
  /\byour\s+(place|home|apartment|flat|dorm|room)\b/i,
  /\bhis\s+(place|home|apartment|flat|dorm|room)\b/i,
  /\bher\s+(place|home|apartment|flat|dorm|room)\b/i,
  /\bprivate\s+(room|residence|address)\b/i,
  /\bbed(\s?room)?\b/i,
  /\bsleep\s?over\b/i,
  /\bchill\s+at\s+(my|your|his|her|mine|yours)\b/i,
];

export interface ParsedVibe {
  /** Whitelisted category after all safety overrides. Never null. */
  category: VenueCategory;
  /** Safe keywords to enrich the Places query. At most 3. May be empty. */
  keywords: string[];
  /**
   * `true` when the original input passed through unchanged; `false` when
   * the deny-list or LLM override coerced it. Callers can use this to
   * audit-log overrides without surfacing them to users.
   */
  safe: boolean;
}

interface LlmVibePayload {
  category?: string;
  keywords?: unknown;
  safe?: unknown;
}

const SAFETY_SYSTEM_PROMPT = `You classify a single-line venue preference for a first date between two university students.

Output STRICT JSON with exactly three keys:
  - "category": one of ["cafe","coffee_shop","restaurant","park","museum","lounge"]
  - "keywords": array of up to 3 short search keywords (e.g. ["vegan"], ["jazz"]).
  - "safe": boolean. false if the user asked for anything private/intimate/unsafe.

Hard rules (JSON):
  - If the user suggests a hotel, motel, hostel, Airbnb, sauna, banya, bathhouse, spa, massage, strip club, pool hall, private residence (their place, your place, dorm room, apartment), or anything sexual/intimate → set category="cafe", keywords=[], safe=false.
  - If the user is vague or empty → category="cafe", keywords=[], safe=true.
  - Never invent a category outside the whitelist. Never emit addresses or personal info.
  - Do not repeat the user text; only emit the classification JSON.`;

/**
 * Parse a single user's vibe text into a safe, whitelisted category.
 *
 * Optional `llm` parameter is for test injection — production code passes
 * nothing and we use `callOpenAIJson`. If the LLM is unavailable or the
 * API key is missing the function still returns a valid result (falling
 * back to the default category), so the venue flow always makes progress.
 */
export async function parseVibe(
  text: string,
  llm: (
    system: string,
    user: string,
  ) => Promise<LlmVibePayload | null> = (s, u) => callOpenAIJson<LlmVibePayload>(s, u),
): Promise<ParsedVibe> {
  const raw = (text ?? "").trim();

  // Layer 1: deterministic deny-list. Fires before any LLM call.
  if (raw.length === 0 || matchesDenyList(raw)) {
    return { category: DEFAULT_CATEGORY, keywords: [], safe: false };
  }

  // Layer 2: LLM classification, with strict schema enforcement.
  let payload: LlmVibePayload | null = null;
  try {
    payload = await llm(SAFETY_SYSTEM_PROMPT, raw);
  } catch {
    payload = null;
  }

  if (!payload) {
    // LLM unreachable — downgrade gracefully, still safe.
    return { category: DEFAULT_CATEGORY, keywords: [], safe: true };
  }

  const category = coerceCategory(payload.category);
  const keywords = sanitizeKeywords(payload.keywords);
  const safeFlag = payload.safe === undefined ? true : Boolean(payload.safe);

  // Even if the LLM said `safe:true`, re-check the emitted keywords against
  // the deny-list — prompt-injection defence.
  const keywordsHit = keywords.some((k) => matchesDenyList(k));
  if (keywordsHit) {
    return { category: DEFAULT_CATEGORY, keywords: [], safe: false };
  }

  return { category, keywords, safe: safeFlag };
}

/**
 * Combine the two users' parsed vibes into a single Places query spec.
 *
 * Merge rules (strict intersection):
 *   - If both users land on the EXACT same category → use it.
 *   - If categories disagree → fall back to the default public `cafe`.
 *     Rationale: if we don't have consensus, the safest product default
 *     is the most universally-acceptable first-date venue. Picking one
 *     user's preference arbitrarily would feel unfair to the other.
 *   - Keywords: dedup union, capped at 3.
 */
export function mergeParsed(a: ParsedVibe, b: ParsedVibe): {
  category: VenueCategory;
  keywords: string[];
} {
  const category = a.category === b.category ? a.category : DEFAULT_CATEGORY;
  const keywords = Array.from(new Set([...a.keywords, ...b.keywords])).slice(0, 3);
  return { category, keywords };
}

function coerceCategory(raw: unknown): VenueCategory {
  if (typeof raw !== "string") return DEFAULT_CATEGORY;
  const normalised = raw.trim().toLowerCase().replace(/\s+/g, "_");
  return (VENUE_CATEGORY_WHITELIST as readonly string[]).includes(normalised)
    ? (normalised as VenueCategory)
    : DEFAULT_CATEGORY;
}

function sanitizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k.length <= 40)
    .slice(0, 3);
}

function matchesDenyList(text: string): boolean {
  return DENY_PATTERNS.some((re) => re.test(text));
}
