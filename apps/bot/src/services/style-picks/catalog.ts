import {
  STYLE_CATEGORIES,
  STYLE_GENDERS,
  STYLE_SHORTLIST_MIN_PER_CATEGORY,
  STYLE_SHORTLIST_SIZE,
  STYLE_TAGS,
  SUPPORTED_LANGUAGES,
  type StyleCategory,
  type StylePicksDigest,
  type StyleTag,
} from "@gennety/shared";

/**
 * Vibe Check catalog: the item shape, the seed-file validator, and step 2 —
 * the deterministic prefilter that turns ~36 products into the ~18 the model
 * sees (decision journal 2026-10-08).
 */

/**
 * `accolade` — a named award or vote; `seenOn` — a celebrity or a film;
 * `popular` — a sourced bestseller / viral claim (2026-10-09: the founder wants
 * badges, not prose, to orient the card). All three are researched catalog
 * facts with a source; the model never writes them.
 */
export type BadgeKind = "accolade" | "seenOn" | "popular";

const BADGE_KINDS: readonly BadgeKind[] = ["accolade", "seenOn", "popular"];

export interface CatalogBadge {
  kind: BadgeKind;
  text: Record<(typeof SUPPORTED_LANGUAGES)[number], string>;
  sourceUrl: string;
}

export interface StyleCatalogItem {
  id: string;
  category: StyleCategory;
  brand: string;
  name: string;
  gender: (typeof STYLE_GENDERS)[number];
  priceTier: number;
  priceEUR: number;
  notes: string;
  tags: string[];
  url: string;
  urlUA: string | null;
  imageUrl: string | null;
  sponsored: boolean;
  affiliateParams: Record<string, string> | null;
  badges: CatalogBadge[];
  active: boolean;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate one catalog entry (the seed file, or a database row). Returns the
 * reasons it is invalid — empty when it is fine. The seeder refuses a file with
 * any, and the service skips a row with any, so a hand-edited typo can never
 * reach a card.
 */
export function catalogItemProblems(raw: unknown): string[] {
  if (!isRecord(raw)) return ["not an object"];
  const p: string[] = [];
  if (typeof raw.id !== "string" || !SLUG.test(raw.id)) p.push("id must be a slug");
  if (!(STYLE_CATEGORIES as readonly unknown[]).includes(raw.category)) p.push("bad category");
  if (!(STYLE_GENDERS as readonly unknown[]).includes(raw.gender)) p.push("bad gender");
  for (const key of ["brand", "name", "notes"] as const) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) p.push(`${key} missing`);
  }
  if (!Number.isInteger(raw.priceTier) || (raw.priceTier as number) < 1 || (raw.priceTier as number) > 3) {
    p.push("priceTier must be 1-3");
  }
  if (typeof raw.priceEUR !== "number" || !(raw.priceEUR > 0)) p.push("priceEUR must be > 0");
  if (
    !Array.isArray(raw.tags) ||
    raw.tags.length === 0 ||
    raw.tags.some((t) => !(STYLE_TAGS as readonly unknown[]).includes(t))
  ) {
    p.push("tags must be non-empty and from STYLE_TAGS");
  }
  if (!isHttpsUrl(raw.url)) p.push("url must be https");
  if (raw.urlUA != null && !isHttpsUrl(raw.urlUA)) p.push("urlUA must be https or null");
  if (raw.imageUrl != null && !isHttpsUrl(raw.imageUrl)) p.push("imageUrl must be https or null");
  if (typeof raw.sponsored !== "boolean") p.push("sponsored must be boolean");
  if (typeof raw.active !== "boolean") p.push("active must be boolean");
  if (raw.affiliateParams != null) {
    if (!isRecord(raw.affiliateParams) || Object.values(raw.affiliateParams).some((v) => typeof v !== "string")) {
      p.push("affiliateParams must be a string map or null");
    }
  }
  if (!Array.isArray(raw.badges)) {
    p.push("badges must be an array");
  } else {
    for (const badge of raw.badges) {
      if (!isRecord(badge) || !(BADGE_KINDS as readonly unknown[]).includes(badge.kind)) {
        p.push("badge kind must be accolade|seenOn|popular");
        continue;
      }
      if (!isHttpsUrl(badge.sourceUrl)) p.push("badge needs an https sourceUrl");
      const text = badge.text;
      if (!isRecord(text) || SUPPORTED_LANGUAGES.some((l) => typeof text[l] !== "string" || !text[l])) {
        p.push("badge text needs every language");
      }
    }
  }
  return p;
}

/** A database row → a catalog item, or null when it is malformed. */
export function toCatalogItem(raw: unknown): StyleCatalogItem | null {
  if (catalogItemProblems(raw).length > 0) return null;
  const row = raw as Record<string, unknown>;
  return {
    id: row.id as string,
    category: row.category as StyleCategory,
    brand: row.brand as string,
    name: row.name as string,
    gender: row.gender as StyleCatalogItem["gender"],
    priceTier: row.priceTier as number,
    priceEUR: row.priceEUR as number,
    notes: row.notes as string,
    tags: row.tags as string[],
    url: row.url as string,
    urlUA: (row.urlUA as string | null) ?? null,
    imageUrl: (row.imageUrl as string | null) ?? null,
    sponsored: row.sponsored as boolean,
    affiliateParams: (row.affiliateParams as Record<string, string> | null) ?? null,
    badges: row.badges as CatalogBadge[],
    active: row.active as boolean,
  };
}

// ── Step 2: the prefilter ──────────────────────────────────────────────────

const PLACE_CATEGORY_TAGS: Record<string, StyleTag[]> = {
  cafe: ["daytime", "urban"],
  coffee_shop: ["daytime", "urban"],
  restaurant: ["evening", "polished"],
  lounge: ["evening", "warm"],
  park: ["daytime", "sporty", "fresh"],
  museum: ["daytime", "creative"],
};

const SPORTY_WORDS = /\b(gym|run|running|football|tennis|padel|yoga|climb|bike|cycling|swim|sport|hike|ski)|спорт|бег|біг|теніс|теннис|зал|йога|плаван|велос|лыж|лиж|футбол/i;
const CREATIVE_WORDS = /\b(art|design|draw|paint|photo|film|theatre|theater|fashion|write|writing)|искусств|мистецт|дизайн|рису|малю|фото|кино|кіно|театр|мода|пиш/i;

/**
 * The style tags a person's digest points at, with weights: the photo
 * archetype counts double — it is the one direct read of how they dress.
 */
export function profileStyleTags(digest: StylePicksDigest): Map<StyleTag, number> {
  const weights = new Map<StyleTag, number>();
  const add = (tag: StyleTag, weight = 1) => weights.set(tag, (weights.get(tag) ?? 0) + weight);
  if (digest.archetype && (STYLE_TAGS as readonly string[]).includes(digest.archetype)) {
    add(digest.archetype as StyleTag, 2);
  }
  if (digest.tempo === "calm") add("calm");
  if (digest.tempo === "energetic") add("energetic");
  if (digest.focus === "connection") add("warm");
  if (digest.focus === "experience") add("statement");
  for (const place of digest.places.slice(0, 3)) {
    for (const tag of PLACE_CATEGORY_TAGS[place.category] ?? []) add(tag);
  }
  const words = [...digest.hobbies, ...digest.anchors].join(" ");
  if (SPORTY_WORDS.test(words)) add("sporty");
  if (CREATIVE_WORDS.test(words)) add("creative");
  return weights;
}

export function genderFits(item: StyleCatalogItem, gender: StylePicksDigest["gender"]): boolean {
  if (item.gender === "unisex") return true;
  if (gender === "man") return item.gender === "men";
  if (gender === "woman") return item.gender === "women";
  return false;
}

/**
 * Active, gender-fitting products ranked by weighted tag overlap; at least
 * `STYLE_SHORTLIST_MIN_PER_CATEGORY` of each category (when the catalog has
 * them), then the best of the rest up to `STYLE_SHORTLIST_SIZE`. Ties break by
 * id, so the same person and catalog give the same shortlist — and the same
 * cache hash.
 */
export function shortlistProducts(
  catalog: StyleCatalogItem[],
  digest: StylePicksDigest,
): StyleCatalogItem[] {
  const weights = profileStyleTags(digest);
  const score = (item: StyleCatalogItem) =>
    item.tags.reduce((sum, tag) => sum + (weights.get(tag as StyleTag) ?? 0), 0);
  const ranked = catalog
    .filter((item) => item.active && genderFits(item, digest.gender))
    .map((item) => ({ item, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));

  const chosen = new Set<string>();
  for (const category of STYLE_CATEGORIES) {
    ranked
      .filter((r) => r.item.category === category)
      .slice(0, STYLE_SHORTLIST_MIN_PER_CATEGORY)
      .forEach((r) => chosen.add(r.item.id));
  }
  for (const r of ranked) {
    if (chosen.size >= STYLE_SHORTLIST_SIZE) break;
    chosen.add(r.item.id);
  }
  return ranked.filter((r) => chosen.has(r.item.id)).map((r) => r.item);
}
