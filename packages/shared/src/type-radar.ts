import type { Gender, GenderPreference } from "./types.js";

/**
 * Type Radar — machine dataset + pure preference math (TYPE_RADAR_PRODUCT_SPEC.md).
 *
 * The radar is a visual appearance-type calibration shown once in onboarding,
 * right before the AI-memory import. The user reacts binary "my type" /
 * "not my type" to a balanced set of contrasting portraits; the server
 * decomposes each photo into pre-authored categorical attribute tags and
 * learns a preference vector that feeds the soft `V_type` match multiplier
 * (launched in shadow mode).
 *
 * This module is the single source of truth for the attribute space, the
 * photo→attribute map, the reason chips, and the pure math. It is deliberately
 * photo-agnostic: photo ids here must match the generated image assets, but no
 * image bytes are referenced. Compiled from
 * `scripts/type-radar.dataset.draft.json` (the human review/generation draft).
 *
 * NOT yet wired into any live path — the feature is behind `TYPE_RADAR_ENABLED`
 * and the match-engine integration lands separately with the schema.
 */

// ── Attribute space ────────────────────────────────────────────────────────
// Deliberately 5 dims per gender: 12 binary answers cannot support more without
// each attribute value falling below the ~4 observations needed to separate
// signal from the per-face noise (see spec "attribute selection" rationale).

export const FEMALE_ATTRIBUTES = {
  hairColor: ["blonde", "brunette", "red"],
  hairLength: ["long", "short"],
  build: ["slim", "athletic", "curvy"],
  style: ["elegant", "sporty", "edgy"],
  tattoos: ["yes", "no"],
} as const;

export const MALE_ATTRIBUTES = {
  hairColor: ["dark", "light"],
  beard: ["clean", "beard"],
  build: ["lean", "athletic", "big"],
  style: ["classic", "sporty", "edgy"],
  tattoos: ["yes", "no"],
} as const;

export type FemaleAttributeKey = keyof typeof FEMALE_ATTRIBUTES;
export type MaleAttributeKey = keyof typeof MALE_ATTRIBUTES;
export type AttributeKey = FemaleAttributeKey | MaleAttributeKey;

/** The gender a set depicts (i.e. the viewer's gender-of-interest). */
export type RadarSet = "female" | "male";

/** A photo's attribute assignment: attribute key → chosen value. */
export type PhotoAttrs = Record<string, string>;

export type RadarScene = "cafe" | "street" | "park";

export interface RadarPhoto {
  /** Stable id (e.g. "f01"/"m07"); must match the generated asset filename. */
  id: string;
  set: RadarSet;
  scene: RadarScene;
  /** Band-invariant attribute assignment (age only re-skins the render). */
  attrs: PhotoAttrs;
}

// ── Age bands ───────────────────────────────────────────────────────────────
// The shown set is age-matched to the viewer's own age (never one young set
// for everyone). The attribute matrix is identical across bands — a band only
// changes the rendered age. Anchor is the viewer's own age, NOT their
// preferred-partner age (that stays owned by V_agePref).

export type AgeBand = "a" | "b" | "c";

export interface AgeBandDef {
  band: AgeBand;
  minAge: number;
  maxAge: number;
}

export const AGE_BANDS: AgeBandDef[] = [
  { band: "a", minAge: 0, maxAge: 28 },
  { band: "b", minAge: 29, maxAge: 37 },
  { band: "c", minAge: 38, maxAge: 200 },
];

/** Map a viewer's own age to the band whose set they should see. */
export function ageBandFor(age: number): AgeBand {
  for (const b of AGE_BANDS) {
    if (age >= b.minAge && age <= b.maxAge) return b.band;
  }
  return "c";
}

// ── Reason chips (Ditto-pattern attribution layer) ──────────────────────────
// A one-tap "why?" after a verdict. A named-attribute chip boosts that
// attribute's weight for the card and discounts the rest; `excludeCard` chips
// (face / bad photo) drop the card from attribute learning entirely — the
// explicit noise channel; `uniform` learns as if no chip was tapped.
// `loggedOnly` chips are recorded for v2 research and never scored.

export type ChipEffect = "attribute" | "excludeCard" | "uniform" | "loggedOnly";

export interface ReasonChip {
  id: string;
  effect: ChipEffect;
  /** For `attribute` chips: which attribute keys the tap credits. */
  attrs?: AttributeKey[];
  maleSetOnly?: boolean;
}

const LIKE_CHIPS: ReasonChip[] = [
  { id: "face", effect: "excludeCard" },
  { id: "figure", effect: "attribute", attrs: ["build"] },
  { id: "hair", effect: "attribute", attrs: ["hairColor", "hairLength"] },
  { id: "style", effect: "attribute", attrs: ["style"] },
  { id: "tattoo", effect: "attribute", attrs: ["tattoos"] },
  { id: "beard", effect: "attribute", attrs: ["beard"], maleSetOnly: true },
  { id: "wholeVibe", effect: "uniform" },
];

const DISLIKE_CHIPS: ReasonChip[] = [
  { id: "face", effect: "excludeCard" },
  { id: "figure", effect: "attribute", attrs: ["build"] },
  { id: "hair", effect: "attribute", attrs: ["hairColor", "hairLength"] },
  { id: "style", effect: "attribute", attrs: ["style"] },
  { id: "tattoo", effect: "attribute", attrs: ["tattoos"] },
  { id: "beard", effect: "attribute", attrs: ["beard"], maleSetOnly: true },
  { id: "tooFlashy", effect: "loggedOnly" },
  { id: "badPhoto", effect: "excludeCard" },
];

export function reasonChipsFor(set: RadarSet, verdict: Verdict): ReasonChip[] {
  const base = verdict === "like" ? LIKE_CHIPS : DISLIKE_CHIPS;
  return base.filter((c) => set === "male" || !c.maleSetOnly);
}

export function reasonChipById(
  set: RadarSet,
  verdict: Verdict,
  id: string,
): ReasonChip | undefined {
  return reasonChipsFor(set, verdict).find((c) => c.id === id);
}

// ── Photo sets (band-invariant attribute assignments) ───────────────────────
// Balanced fractional-factorial plan: each attribute value appears 4–6×, with
// attribute pairs decorrelated by construction. Scene is a balanced nuisance
// factor (4 photos per scene), not a preference dimension.

export const FEMALE_PHOTOS: RadarPhoto[] = [
  { id: "f01", set: "female", scene: "cafe", attrs: { hairColor: "blonde", hairLength: "long", build: "slim", style: "elegant", tattoos: "no" } },
  { id: "f02", set: "female", scene: "cafe", attrs: { hairColor: "brunette", hairLength: "long", build: "athletic", style: "sporty", tattoos: "no" } },
  { id: "f03", set: "female", scene: "park", attrs: { hairColor: "red", hairLength: "short", build: "slim", style: "edgy", tattoos: "yes" } },
  { id: "f04", set: "female", scene: "street", attrs: { hairColor: "brunette", hairLength: "short", build: "curvy", style: "elegant", tattoos: "no" } },
  { id: "f05", set: "female", scene: "cafe", attrs: { hairColor: "blonde", hairLength: "short", build: "athletic", style: "edgy", tattoos: "yes" } },
  { id: "f06", set: "female", scene: "cafe", attrs: { hairColor: "red", hairLength: "long", build: "curvy", style: "sporty", tattoos: "no" } },
  { id: "f07", set: "female", scene: "street", attrs: { hairColor: "brunette", hairLength: "long", build: "slim", style: "sporty", tattoos: "yes" } },
  { id: "f08", set: "female", scene: "street", attrs: { hairColor: "blonde", hairLength: "long", build: "curvy", style: "edgy", tattoos: "no" } },
  { id: "f09", set: "female", scene: "street", attrs: { hairColor: "red", hairLength: "short", build: "athletic", style: "elegant", tattoos: "no" } },
  { id: "f10", set: "female", scene: "park", attrs: { hairColor: "brunette", hairLength: "short", build: "slim", style: "edgy", tattoos: "no" } },
  { id: "f11", set: "female", scene: "park", attrs: { hairColor: "blonde", hairLength: "short", build: "curvy", style: "sporty", tattoos: "yes" } },
  { id: "f12", set: "female", scene: "park", attrs: { hairColor: "red", hairLength: "long", build: "athletic", style: "elegant", tattoos: "yes" } },
];

export const MALE_PHOTOS: RadarPhoto[] = [
  { id: "m01", set: "male", scene: "cafe", attrs: { hairColor: "dark", beard: "clean", build: "lean", style: "classic", tattoos: "no" } },
  { id: "m02", set: "male", scene: "cafe", attrs: { hairColor: "light", beard: "beard", build: "athletic", style: "sporty", tattoos: "no" } },
  { id: "m03", set: "male", scene: "cafe", attrs: { hairColor: "dark", beard: "beard", build: "athletic", style: "edgy", tattoos: "yes" } },
  { id: "m04", set: "male", scene: "street", attrs: { hairColor: "light", beard: "clean", build: "athletic", style: "classic", tattoos: "no" } },
  { id: "m05", set: "male", scene: "street", attrs: { hairColor: "dark", beard: "beard", build: "big", style: "sporty", tattoos: "no" } },
  { id: "m06", set: "male", scene: "park", attrs: { hairColor: "light", beard: "clean", build: "lean", style: "edgy", tattoos: "yes" } },
  { id: "m07", set: "male", scene: "street", attrs: { hairColor: "dark", beard: "clean", build: "athletic", style: "sporty", tattoos: "yes" } },
  { id: "m08", set: "male", scene: "street", attrs: { hairColor: "light", beard: "beard", build: "lean", style: "classic", tattoos: "yes" } },
  { id: "m09", set: "male", scene: "park", attrs: { hairColor: "dark", beard: "beard", build: "lean", style: "sporty", tattoos: "no" } },
  { id: "m10", set: "male", scene: "cafe", attrs: { hairColor: "light", beard: "clean", build: "big", style: "edgy", tattoos: "no" } },
  { id: "m11", set: "male", scene: "park", attrs: { hairColor: "dark", beard: "clean", build: "big", style: "classic", tattoos: "yes" } },
  { id: "m12", set: "male", scene: "park", attrs: { hairColor: "light", beard: "beard", build: "big", style: "edgy", tattoos: "no" } },
];

export function photosForSet(set: RadarSet): RadarPhoto[] {
  return set === "female" ? FEMALE_PHOTOS : MALE_PHOTOS;
}

export function radarPhotoById(id: string): RadarPhoto | undefined {
  return id.startsWith("f")
    ? FEMALE_PHOTOS.find((p) => p.id === id)
    : MALE_PHOTOS.find((p) => p.id === id);
}

export function attributeKeysForSet(set: RadarSet): AttributeKey[] {
  return Object.keys(set === "female" ? FEMALE_ATTRIBUTES : MALE_ATTRIBUTES) as AttributeKey[];
}

/**
 * Which photo set(s) a viewer sees, from their gender-of-interest.
 * `both` interleaves an 8+8 subset (lower confidence, handled by shrinkage).
 */
export function setsForPreference(pref: GenderPreference): RadarSet[] {
  if (pref === "men") return ["male"];
  if (pref === "women") return ["female"];
  return ["female", "male"];
}

/** Convenience: the set a viewer of the given gender is themselves in. */
export function setForGender(gender: Gender): RadarSet {
  return gender === "female" ? "female" : "male";
}

export type Verdict = "like" | "dislike";

// ── Preference math (pure) ──────────────────────────────────────────────────
// The candidate side (attractiveness LEVEL) is owned by Elo/V_league; this
// learns appearance DIRECTION only, from categorical tags. All functions here
// are pure and DB-free so they can be unit-tested exhaustively; the bot service
// wraps them with Profile reads/writes.

/** One recorded radar reaction. `chipId` is the reason chip tapped, if any. */
export interface RadarAnswer {
  photoId: string;
  verdict: Verdict;
  chipId?: string | null | undefined;
}

/** Learned preference for one attribute value. */
export interface AttrValuePreference {
  /** (likeW − dislikeW) / shownW ∈ [−1, 1] — direction, weighted by chips. */
  score: number;
  /** min(1, rawShownCount / CONF_FULL) ∈ [0, 1] — data-volume shrinkage. */
  confidence: number;
  /** score · confidence — the value used when scoring candidates. */
  weight: number;
}

/** attributeKey → attributeValue → learned preference. */
export type PreferenceVector = Record<string, Record<string, AttrValuePreference>>;

/** Cards a reason chip credits its named attribute above the rest. */
export const CHIP_ATTR_BOOST = 2;
/** Non-named attributes on a chip-attributed card are discounted, not zeroed. */
export const CHIP_ATTR_DISCOUNT = 0.25;
/** Raw shown count at which an attribute value reaches full confidence. */
export const CONF_FULL = 4;

/**
 * Per-(card, attribute) learning weight given the tapped reason chip.
 * `excludeCard` (face / bad photo) → 0 everywhere: the explicit noise channel.
 * An `attribute` chip boosts its named attribute(s) and discounts the rest.
 * `uniform` / `loggedOnly` / no chip → weight 1 for every attribute.
 */
function cardAttributeWeight(
  set: RadarSet,
  verdict: Verdict,
  chipId: string | null | undefined,
  attrKey: AttributeKey,
): number {
  if (!chipId) return 1;
  const chip = reasonChipById(set, verdict, chipId);
  if (!chip) return 1;
  switch (chip.effect) {
    case "excludeCard":
      return 0;
    case "attribute":
      return chip.attrs?.includes(attrKey) ? CHIP_ATTR_BOOST : CHIP_ATTR_DISCOUNT;
    case "uniform":
    case "loggedOnly":
    default:
      return 1;
  }
}

/**
 * Build the preference vector from a user's radar answers for one set.
 * Answers referencing photos outside the set are ignored (a `both` viewer
 * accumulates each set independently).
 */
export function buildPreferenceVector(set: RadarSet, answers: RadarAnswer[]): PreferenceVector {
  const keys = attributeKeysForSet(set);
  // acc[attr][value] = { likeW, dislikeW, shown }
  const acc: Record<string, Record<string, { likeW: number; dislikeW: number; shown: number }>> = {};
  for (const key of keys) acc[key] = {};

  for (const ans of answers) {
    const photo = radarPhotoById(ans.photoId);
    if (!photo || photo.set !== set) continue;
    for (const key of keys) {
      const value = photo.attrs[key];
      if (value === undefined) continue;
      const w = cardAttributeWeight(set, ans.verdict, ans.chipId, key);
      const bucket = (acc[key][value] ??= { likeW: 0, dislikeW: 0, shown: 0 });
      bucket.shown += 1; // raw count drives confidence, unaffected by chips
      if (w === 0) continue; // excluded card: counts as shown but not learned
      if (ans.verdict === "like") bucket.likeW += w;
      else bucket.dislikeW += w;
    }
  }

  const out: PreferenceVector = {};
  for (const key of keys) {
    out[key] = {};
    for (const [value, b] of Object.entries(acc[key])) {
      const shownW = b.likeW + b.dislikeW;
      const score = shownW > 0 ? (b.likeW - b.dislikeW) / shownW : 0;
      const confidence = Math.min(1, b.shown / CONF_FULL);
      out[key][value] = { score, confidence, weight: score * confidence };
    }
  }
  return out;
}

/** Clamp helper. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Score a candidate's appearance tags against a learned preference vector.
 * Returns `typeScore ∈ [0, 1]` (0.5 = neutral). The match engine maps this to
 * the `V_type` multiplier and averages both directions of a pair.
 *
 * Only attributes present on BOTH sides contribute; a candidate tag the viewer
 * has no signal on is skipped (not penalized). No overlap → neutral 0.5, so a
 * viewer who skipped the radar or a tagless candidate never distorts scoring.
 */
export function candidateTypeScore(pref: PreferenceVector, candidateTags: PhotoAttrs): number {
  let sum = 0;
  let n = 0;
  for (const [key, value] of Object.entries(candidateTags)) {
    const w = pref[key]?.[value]?.weight;
    if (w === undefined) continue;
    sum += w;
    n += 1;
  }
  if (n === 0) return 0.5;
  const raw = sum / n; // ∈ [−1, 1]
  return clamp01(0.5 + 0.5 * raw);
}

/** True once the vector carries any usable directional signal at all. */
export function hasTypeSignal(pref: PreferenceVector): boolean {
  for (const values of Object.values(pref)) {
    for (const p of Object.values(values)) {
      if (Math.abs(p.weight) > 0) return true;
    }
  }
  return false;
}
