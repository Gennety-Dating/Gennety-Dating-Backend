import {
  STYLE_BASIS_MAX,
  STYLE_CATEGORIES,
  STYLE_FOR_YOU_MAX,
  STYLE_FOR_YOU_MIN_SCORE,
  STYLE_PICKS_MIN_TOTAL,
  STYLE_PICKS_PER_CATEGORY,
  STYLE_REASON_MAX_CHARS,
  STYLE_SIGNALS_MAX,
  STYLE_SIGNAL_MAX_CHARS,
  SUPPORTED_LANGUAGES,
} from "@gennety/shared";
import type { StyleCatalogItem } from "./catalog.js";

/**
 * Vibe Check, step 4: what the model said, made safe to show
 * (decision journal 2026-10-08).
 *
 * The model only ever chooses and explains. Ids outside the shortlist and
 * repeats are dropped, a category keeps at most its share, every string is
 * clamped. Nothing is invented to fill a gap: a category the model under-filled
 * simply has fewer cards, and fewer than `STYLE_PICKS_MIN_TOTAL` valid picks
 * counts as a failed generation. The "for you" badge is computed here from
 * `fitScore` + `personalSignalCited`, never written by the model.
 */

export interface RawStylePicks {
  basis?: unknown;
  picks?: unknown;
}

export interface StoredPick {
  id: string;
  fitScore: number;
  reason: string;
  signals: string[];
  forYou: boolean;
}

export interface StoredPickSet {
  basis: string[];
  picks: StoredPick[];
}

function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

function strings(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = clamp(item, maxChars);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export function validateStylePicks(
  raw: RawStylePicks | null,
  shortlist: StyleCatalogItem[],
): StoredPickSet | null {
  if (!raw || !Array.isArray(raw.picks)) return null;
  const byId = new Map(shortlist.map((item) => [item.id, item]));
  const perCategory = new Map<string, number>();
  const seen = new Set<string>();
  const candidates: Array<StoredPick & { cited: boolean }> = [];

  for (const entry of raw.picks) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    const used = perCategory.get(item.category) ?? 0;
    if (used >= STYLE_PICKS_PER_CATEGORY) continue;
    const reason = typeof e.reason === "string" ? clamp(e.reason, STYLE_REASON_MAX_CHARS) : "";
    if (!reason) continue;
    const score = typeof e.fitScore === "number" && Number.isFinite(e.fitScore) ? e.fitScore : 0;
    seen.add(id);
    perCategory.set(item.category, used + 1);
    candidates.push({
      id,
      fitScore: Math.max(0, Math.min(100, Math.round(score))),
      reason,
      signals: strings(e.signals, STYLE_SIGNALS_MAX, STYLE_SIGNAL_MAX_CHARS),
      forYou: false,
      cited: e.personalSignalCited === true,
    });
  }
  if (candidates.length < STYLE_PICKS_MIN_TOTAL) return null;

  // "For you": strong score AND a personal fact cited, the best two at most.
  const eligible = candidates
    .filter((c) => c.cited && c.fitScore >= STYLE_FOR_YOU_MIN_SCORE)
    .sort((a, b) => b.fitScore - a.fitScore || a.id.localeCompare(b.id))
    .slice(0, STYLE_FOR_YOU_MAX);
  for (const c of eligible) c.forYou = true;

  // Card order: category by category (scent, accents, grooming), best first.
  const order = (id: string) => STYLE_CATEGORIES.indexOf(byId.get(id)!.category);
  const picks = candidates
    .sort((a, b) => order(a.id) - order(b.id) || b.fitScore - a.fitScore)
    .map(({ cited: _cited, ...pick }) => pick);

  return { basis: strings(raw.basis, STYLE_BASIS_MAX, STYLE_SIGNAL_MAX_CHARS), picks };
}

export type ResponseBadge =
  | { kind: "forYou" }
  | { kind: "accolade" | "seenOn" | "popular"; text: string; sourceUrl: string };

/**
 * A card's badges: "for you" first when granted, then the catalog's own
 * (researched, sourced) badges in the person's language.
 */
export function badgesFor(item: StyleCatalogItem, forYou: boolean, language: string): ResponseBadge[] {
  const lang = (SUPPORTED_LANGUAGES as readonly string[]).includes(language)
    ? (language as (typeof SUPPORTED_LANGUAGES)[number])
    : "en";
  const out: ResponseBadge[] = forYou ? [{ kind: "forYou" }] : [];
  for (const badge of item.badges) {
    out.push({ kind: badge.kind, text: badge.text[lang] ?? badge.text.en, sourceUrl: badge.sourceUrl });
  }
  return out;
}
