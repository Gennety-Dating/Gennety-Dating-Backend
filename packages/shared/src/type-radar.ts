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
// ONE primary axis — `archetype` (4 values, 3 cards each) — plus three
// secondary tags. Rewritten 2026-08-28 (DECISIONS.md): the v1 space scored five
// independent visual features, which meant every card credited five cells at
// once, so a like driven by one of them was recorded against all five. The
// archetype is a whole read of a person (clothes + place + posture), so one
// verdict now credits one cell, and the secondaries are decorrelated from it by
// construction — no archetype holds a constant value on any of them.
//
// `build` is DROPPED and must not come back on the strength of "it feels like a
// dimension". A full audit of the v1 band-A renders (2026-08-20) found the
// female `build` cells did not exist on screen at all: four cards declared
// `curvy` and four `athletic`, and all twelve women read as slim — so eight of
// twelve cards taught a distinction the viewer could not see, while the "figure"
// reason chip credited exactly that cell. It is also the attribute a VLM reads
// least reliably off a candidate's own photos, and ranking people by body type
// through an automated decision is the most exposed thing left after
// `ethnicity` was removed under Art. 9.
//
// Haircut is deliberately NOT measured: hair LENGTH (women) / BEARD (men) is,
// and that is the same slot the v1 space already had.

export const ARCHETYPES = ["polished", "sporty", "urban", "creative"] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/**
 * What each archetype looks like, in terms an observer can check. This is the
 * SINGLE source shared by the deck brief (`scripts/type-radar.deck-v2.md`) and
 * the candidate-side vision tagger (`services/vision/tag-appearance.ts`) — a
 * label with no definition would be classified one way in the deck and another
 * way on a real profile, and the two sides would silently stop describing the
 * same thing.
 *
 * Deliberately GENDER-NEUTRAL: one description serves both sets, so naming a
 * gendered garment ("a slip dress") would put it in front of a classifier
 * reading a man's photos. Say the register, not the item.
 */
export const ARCHETYPE_DESCRIPTIONS: Record<Archetype, string> = {
  polished:
    "put-together and expensive-looking: tailored or dressy clothes, a blazer " +
    "or a coat over something smart, neat grooming, upmarket settings " +
    "(a hotel lobby, a golf club, a theatre foyer)",
  sporty:
    "athletic and outdoorsy: technical or gym wear, a tennis or running look, " +
    "trainers, active settings (a court, a gym, a waterfront)",
  urban:
    "everyday modern city casual: jeans, a plain tee or a knit, sneakers, " +
    "ordinary city settings (an evening street, a bookshop cafe, a park)",
  creative:
    "expressive and a little unconventional: layered or vintage pieces, " +
    "texture and pattern, arts-adjacent settings (a wine bar, a record cafe)",
};

export const FEMALE_ATTRIBUTES = {
  archetype: ARCHETYPES,
  hairColor: ["blonde", "brunette", "red"],
  hairLength: ["long", "short"],
  tattoos: ["yes", "no"],
} as const;

export const MALE_ATTRIBUTES = {
  archetype: ARCHETYPES,
  hairColor: ["dark", "light"],
  beard: ["clean", "beard"],
  tattoos: ["yes", "no"],
} as const;

/**
 * How much each attribute counts when scoring a candidate. The archetype is the
 * primary axis and outweighs any single secondary tag.
 *
 * This exists because confidence shrinkage would otherwise INVERT the intended
 * ranking, which is easy to miss: with 12 cards over 4 archetypes each value is
 * shown exactly 3 times, so `confidence = 3/CONF_FULL = 0.75` and an archetype's
 * weight is capped below a hair-length value shown 6 times (confidence 1.0).
 * That damping is correct on its own terms — 3 observations really is thinner
 * evidence than 6 — so the fix is not to loosen it but to say outright that one
 * archetype observation is worth more than one hair observation. At weight 2
 * against three secondaries at 1, the archetype carries 2 x 0.75 = 1.5 of a
 * possible 5, i.e. ~30% of the score and the single largest term.
 */
export const ATTR_WEIGHTS: Record<string, number> = {
  archetype: 2,
};
/** Weight for an attribute with no explicit entry above. */
export const ATTR_WEIGHT_DEFAULT = 1;

export function attributeWeight(key: string): number {
  return ATTR_WEIGHTS[key] ?? ATTR_WEIGHT_DEFAULT;
}

export type FemaleAttributeKey = keyof typeof FEMALE_ATTRIBUTES;
export type MaleAttributeKey = keyof typeof MALE_ATTRIBUTES;
export type AttributeKey = FemaleAttributeKey | MaleAttributeKey;

/** The gender a set depicts (i.e. the viewer's gender-of-interest). */
export type RadarSet = "female" | "male";

/** A photo's attribute assignment: attribute key → chosen value. */
export type PhotoAttrs = Record<string, string>;

/**
 * Where a card was shot. Since v2 this is PART of the archetype construct rather
 * than a nuisance factor to be held to three values: a polished person is partly
 * polished by being in a hotel lobby. It is still never scored and never sent to
 * a client — what keeps it from becoming a hidden attribute is the deck
 * discipline instead (each archetype spans several locations, and three
 * locations are shared BETWEEN archetypes so the backdrop alone cannot identify
 * one). `type-radar.test.ts` holds both properties.
 */
export type RadarLocation =
  | "golf_club"
  | "hotel_lobby"
  | "theatre_foyer"
  | "cafe"
  | "bookshop_cafe"
  | "wine_bar"
  | "tennis_court"
  | "gym"
  | "quay"
  | "park"
  | "night_street";

export interface RadarPhoto {
  /** Stable id (e.g. "fp1"/"ma3"); must match the generated asset filename. */
  id: string;
  set: RadarSet;
  location: RadarLocation;
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

/**
 * Age bands whose portrait sets actually exist and are deployed. v1 ships band
 * A (`apps/webapp/public/radar/a/`) only; B/C portrait sets aren't generated
 * yet. Serving band-A (young) photos to an older viewer would reintroduce the
 * exact age-mismatch the bands exist to prevent, so the onboarding gate and the
 * deck route only run for a viewer whose band is live. Extend this as B/C ship.
 */
export const RADAR_LIVE_BANDS: readonly AgeBand[] = ["a"];

/** True when a viewer's age band has a deployed portrait set. */
export function radarBandLive(band: AgeBand): boolean {
  return RADAR_LIVE_BANDS.includes(band);
}

// ── Reason chips (Ditto-pattern attribution layer) ──────────────────────────
// A one-tap "why?" after a verdict. A named-attribute chip boosts that
// attribute's weight for the card and discounts the rest; `excludeCard` chips
// (face / bad photo) drop the card from attribute learning entirely — the
// explicit noise channel; `uniform` learns as if no chip was tapped.
// `loggedOnly` chips are recorded for research and never scored.
//
// The `figure` chip was REMOVED with `build` (2026-08-28) rather than repointed
// at something else. Its whole job was to credit a cell, and a chip that names a
// dimension the deck does not vary tells the user it does — which is the exact
// defect the audit found. `face` and `badPhoto` remain the noise channels.
// `style` now credits the archetype: the chip already read as "the whole look",
// which is what the archetype is, so no label changed.

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
  { id: "hair", effect: "attribute", attrs: ["hairColor", "hairLength"] },
  { id: "style", effect: "attribute", attrs: ["archetype"] },
  { id: "tattoo", effect: "attribute", attrs: ["tattoos"] },
  { id: "beard", effect: "attribute", attrs: ["beard"], maleSetOnly: true },
  { id: "wholeVibe", effect: "uniform" },
];

const DISLIKE_CHIPS: ReasonChip[] = [
  { id: "face", effect: "excludeCard" },
  { id: "hair", effect: "attribute", attrs: ["hairColor", "hairLength"] },
  { id: "style", effect: "attribute", attrs: ["archetype"] },
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

/**
 * "Presence" attributes whose reason chip only makes sense when the feature is
 * actually visible on THIS photo. Offering "beard" on a clean-shaven man (or
 * "tattoo" on someone with none) reads as a bug to the user and pollutes the
 * signal. Build / hair / style are universal (everyone has them), so their
 * chips always apply.
 */
function chipAppliesToPhoto(chip: ReasonChip, photo: RadarPhoto): boolean {
  if (chip.id === "beard") return photo.attrs.beard === "beard";
  if (chip.id === "tattoo") return photo.attrs.tattoos === "yes";
  return true;
}

/**
 * Reason chips for a SPECIFIC photo: the set-level chips minus any
 * presence-only chip (beard / tattoo) the photo doesn't actually exhibit, so a
 * "why?" prompt never offers a trait the person on screen doesn't have.
 */
export function reasonChipsForPhoto(photo: RadarPhoto, verdict: Verdict): ReasonChip[] {
  return reasonChipsFor(photo.set, verdict).filter((c) => chipAppliesToPhoto(c, photo));
}

// ── Photo sets (band-invariant attribute assignments) ──────────────────────
// Ids are mnemonic: set letter + archetype letter (p/s/c/a) + index, so a card's
// primary cell is readable from its filename and a mis-filed asset is visible
// without opening it.
//
// The plan is decorrelated by construction and `type-radar.test.ts` enforces it:
// each archetype is shown 3x, no archetype carries a constant value on any
// secondary axis, and exactly one card per archetype has a tattoo. Counts are
// deliberately uneven where a decision says so — female hair is 5 blonde /
// 5 brunette / 2 red rather than 4/4/4 (founder, 2026-08-23): a third of the
// deck spent on a colour that is a few percent of the real pool bought
// measurement precision nobody could use. The arithmetic makes it nearly free —
// `confidence` caps at CONF_FULL = 4, so 5 scores exactly like 4 — and the cost
// is confined to `red`, which drops to 0.5.
//
// The ids CHANGED at v2 (f01..m12 -> fp1..ma3) and old recorded answers are
// therefore unresolvable. That is deliberate rather than tolerated: a vector
// built on the v1 attribute space must not survive into this one. Nothing needs
// migrating, because both sides degrade to neutral on their own — a stale
// preference vector holds keys (`build`, `style`) no candidate is tagged with
// any more, and stale candidate tags hold values no viewer has learned on, so
// `typeOverlapCount` is 0 and `typePreferenceMultiplier` returns exactly 1.0.

export const FEMALE_PHOTOS: RadarPhoto[] = [
  { id: "fp1", set: "female", location: "golf_club", attrs: { archetype: "polished", hairColor: "blonde", hairLength: "long", tattoos: "no" } },
  { id: "fp2", set: "female", location: "hotel_lobby", attrs: { archetype: "polished", hairColor: "brunette", hairLength: "short", tattoos: "no" } },
  { id: "fp3", set: "female", location: "cafe", attrs: { archetype: "polished", hairColor: "red", hairLength: "long", tattoos: "yes" } },
  { id: "fs1", set: "female", location: "tennis_court", attrs: { archetype: "sporty", hairColor: "brunette", hairLength: "long", tattoos: "no" } },
  { id: "fs2", set: "female", location: "quay", attrs: { archetype: "sporty", hairColor: "blonde", hairLength: "short", tattoos: "yes" } },
  { id: "fs3", set: "female", location: "park", attrs: { archetype: "sporty", hairColor: "red", hairLength: "short", tattoos: "no" } },
  { id: "fc1", set: "female", location: "night_street", attrs: { archetype: "urban", hairColor: "blonde", hairLength: "long", tattoos: "no" } },
  { id: "fc2", set: "female", location: "bookshop_cafe", attrs: { archetype: "urban", hairColor: "blonde", hairLength: "short", tattoos: "no" } },
  { id: "fc3", set: "female", location: "park", attrs: { archetype: "urban", hairColor: "brunette", hairLength: "long", tattoos: "yes" } },
  { id: "fa1", set: "female", location: "wine_bar", attrs: { archetype: "creative", hairColor: "brunette", hairLength: "short", tattoos: "no" } },
  { id: "fa2", set: "female", location: "night_street", attrs: { archetype: "creative", hairColor: "blonde", hairLength: "short", tattoos: "yes" } },
  { id: "fa3", set: "female", location: "cafe", attrs: { archetype: "creative", hairColor: "brunette", hairLength: "long", tattoos: "no" } },
];

export const MALE_PHOTOS: RadarPhoto[] = [
  { id: "mp1", set: "male", location: "golf_club", attrs: { archetype: "polished", hairColor: "dark", beard: "clean", tattoos: "no" } },
  { id: "mp2", set: "male", location: "theatre_foyer", attrs: { archetype: "polished", hairColor: "light", beard: "beard", tattoos: "no" } },
  { id: "mp3", set: "male", location: "cafe", attrs: { archetype: "polished", hairColor: "dark", beard: "beard", tattoos: "yes" } },
  { id: "ms1", set: "male", location: "tennis_court", attrs: { archetype: "sporty", hairColor: "dark", beard: "beard", tattoos: "no" } },
  { id: "ms2", set: "male", location: "gym", attrs: { archetype: "sporty", hairColor: "light", beard: "clean", tattoos: "yes" } },
  { id: "ms3", set: "male", location: "quay", attrs: { archetype: "sporty", hairColor: "dark", beard: "clean", tattoos: "no" } },
  { id: "mc1", set: "male", location: "night_street", attrs: { archetype: "urban", hairColor: "dark", beard: "clean", tattoos: "no" } },
  { id: "mc2", set: "male", location: "bookshop_cafe", attrs: { archetype: "urban", hairColor: "light", beard: "beard", tattoos: "yes" } },
  { id: "mc3", set: "male", location: "quay", attrs: { archetype: "urban", hairColor: "dark", beard: "clean", tattoos: "no" } },
  { id: "ma1", set: "male", location: "wine_bar", attrs: { archetype: "creative", hairColor: "dark", beard: "clean", tattoos: "yes" } },
  { id: "ma2", set: "male", location: "night_street", attrs: { archetype: "creative", hairColor: "light", beard: "beard", tattoos: "no" } },
  { id: "ma3", set: "male", location: "cafe", attrs: { archetype: "creative", hairColor: "dark", beard: "beard", tattoos: "no" } },
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
 *
 * The mean is WEIGHTED by `attributeWeight` (see ATTR_WEIGHTS), so the archetype
 * outweighs any single secondary tag. Weighting the mean rather than the learned
 * weights keeps the result in [−1, 1] by construction whatever the weights are.
 */
export function candidateTypeScore(pref: PreferenceVector, candidateTags: PhotoAttrs): number {
  let sum = 0;
  let wsum = 0;
  for (const [key, value] of Object.entries(candidateTags)) {
    const w = pref[key]?.[value]?.weight;
    if (w === undefined) continue;
    const kw = attributeWeight(key);
    sum += w * kw;
    wsum += kw;
  }
  if (wsum === 0) return 0.5;
  const raw = sum / wsum; // ∈ [−1, 1]
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

/**
 * Number of candidate tags the viewer actually has learned signal on — the
 * overlap that `candidateTypeScore` averages over. Zero means "no information",
 * which the multiplier below treats as fully neutral (not as an average 0.5).
 */
export function typeOverlapCount(pref: PreferenceVector, candidateTags: PhotoAttrs): number {
  let n = 0;
  for (const [key, value] of Object.entries(candidateTags)) {
    if (pref[key]?.[value]?.weight !== undefined) n += 1;
  }
  return n;
}

/**
 * Map a preference vector + a candidate's appearance tags to the `V_type`
 * multiplier applied to the positive bracket of the match score. Best-type
 * candidate → 1.0 (no damping); worst-type → `floor`; a purely average
 * candidate → the floor-blended midpoint.
 *
 * Returns exactly `1.0` (fully neutral — zero effect on ranking) whenever there
 * is nothing to act on, so the factor is safe to leave wired everywhere:
 *   - `floor >= 1` — shadow mode (`TYPE_PREF_FLOOR` default 1.0): no-op.
 *   - the viewer has no directional radar signal (skipped / undecided radar).
 *   - the candidate has no overlapping tag the viewer has learned on.
 *
 * `floor` is clamped to [0, 1]. Pure and env-free: the engine passes the env
 * floor and gates on `TYPE_RADAR_ENABLED` before calling.
 */
export function typePreferenceMultiplier(
  pref: PreferenceVector,
  candidateTags: PhotoAttrs,
  floor: number,
): number {
  const f = floor < 0 ? 0 : floor > 1 ? 1 : floor;
  if (f >= 1) return 1;
  if (!hasTypeSignal(pref)) return 1;
  if (typeOverlapCount(pref, candidateTags) === 0) return 1;
  const s = candidateTypeScore(pref, candidateTags); // ∈ [0, 1], 0.5 = neutral
  return f + (1 - f) * s;
}
