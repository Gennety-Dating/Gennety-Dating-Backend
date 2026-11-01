/**
 * Gennety's memory of what a person wants (decision journal 2026-11-01).
 * The vocabulary and the rules every consumer shares. A source is what was
 * saved, an idea is the thing itself, and the fields on it say what the person
 * means and where it may be used. Nothing here reads from a model's guess: a
 * guess stays on the source, and only the person's answer lands on the idea.
 */

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

/** May this idea be added to the wishlist a partner can buy into? Never someone else's gift. */
export function usableForPartnerWishlist(idea: MemoryIdeaGate): boolean {
  return idea.allowPartner && liveOwnWish(idea);
}

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
