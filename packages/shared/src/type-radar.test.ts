import { describe, it, expect } from "vitest";
import {
  ARCHETYPES,
  attributeWeight,
  FEMALE_PHOTOS,
  MALE_PHOTOS,
  FEMALE_ATTRIBUTES,
  MALE_ATTRIBUTES,
  ageBandFor,
  setsForPreference,
  reasonChipsFor,
  buildPreferenceVector,
  candidateTypeScore,
  hasTypeSignal,
  typeOverlapCount,
  typePreferenceMultiplier,
  CONF_FULL,
  type PreferenceVector,
  type RadarAnswer,
  type RadarSet,
} from "./type-radar.js";

// ── Dataset integrity ───────────────────────────────────────────────────────

describe("radar dataset integrity", () => {
  it("has 12 photos per set with unique ids", () => {
    expect(FEMALE_PHOTOS).toHaveLength(12);
    expect(MALE_PHOTOS).toHaveLength(12);
    const ids = [...FEMALE_PHOTOS, ...MALE_PHOTOS].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every photo carries exactly the set's attribute keys with valid values", () => {
    const check = (photos: typeof FEMALE_PHOTOS, attrs: Record<string, readonly string[]>) => {
      for (const p of photos) {
        expect(Object.keys(p.attrs).sort()).toEqual(Object.keys(attrs).sort());
        for (const [key, value] of Object.entries(p.attrs)) {
          expect(attrs[key]).toContain(value);
        }
      }
    };
    check(FEMALE_PHOTOS, FEMALE_ATTRIBUTES);
    check(MALE_PHOTOS, MALE_ATTRIBUTES);
  });

  it("names every card after the archetype it teaches", () => {
    // The id is the only thing a reviewer sees when filing 24 renders, so a
    // mis-filed asset has to be visible without opening it.
    const letter: Record<string, string> = { p: "polished", s: "sporty", c: "urban", a: "creative" };
    for (const photos of [FEMALE_PHOTOS, MALE_PHOTOS]) {
      for (const p of photos) {
        expect(p.id).toMatch(/^[fm][psca]\d$/);
        expect(p.attrs.archetype).toBe(letter[p.id[1]]);
      }
    }
  });

  it("decorrelates every secondary axis from the archetype", () => {
    // The property the whole v2 deck exists for: if an archetype always carried
    // the same beard/hair/tattoo value, a verdict on it could not be told apart
    // from a verdict on that secondary — which is how "we learned a preference
    // for beards and called it a type" happens.
    for (const photos of [FEMALE_PHOTOS, MALE_PHOTOS]) {
      const secondary = Object.keys(photos[0].attrs).filter((k) => k !== "archetype");
      for (const archetype of ARCHETYPES) {
        const cards = photos.filter((p) => p.attrs.archetype === archetype);
        expect(cards).toHaveLength(3);
        for (const key of secondary) {
          const values = new Set(cards.map((p) => p.attrs[key]));
          expect(values.size).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("gives every archetype exactly one tattooed card", () => {
    for (const photos of [FEMALE_PHOTOS, MALE_PHOTOS]) {
      for (const archetype of ARCHETYPES) {
        const inked = photos.filter(
          (p) => p.attrs.archetype === archetype && p.attrs.tattoos === "yes",
        );
        expect(inked).toHaveLength(1);
      }
    }
  });

  it("balances every attribute value across at least two locations", () => {
    // Location is part of the archetype construct since v2, not a nuisance
    // factor held to three values — but a value shot in only ONE place is
    // indistinguishable from a preference for that place, so this still holds.
    for (const photos of [FEMALE_PHOTOS, MALE_PHOTOS]) {
      const keys = Object.keys(photos[0].attrs);
      for (const key of keys) {
        const byValue: Record<string, Set<string>> = {};
        for (const p of photos) (byValue[p.attrs[key]] ??= new Set()).add(p.location);
        for (const [, locations] of Object.entries(byValue)) {
          expect(locations.size).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("shares at least one location between archetypes", () => {
    // The insurance against identifying an archetype from the backdrop alone.
    for (const photos of [FEMALE_PHOTOS, MALE_PHOTOS]) {
      const archetypesByLocation: Record<string, Set<string>> = {};
      for (const p of photos) {
        (archetypesByLocation[p.location] ??= new Set()).add(p.attrs.archetype);
      }
      const shared = Object.values(archetypesByLocation).filter((s) => s.size >= 2);
      expect(shared.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("shows each attribute value enough times to reach confidence", () => {
    // Two deliberate exceptions, both recorded decisions rather than drift, so
    // a value that thins out by accident still fails here:
    //   - `archetype` is 3 by construction (12 cards / 4 values) — the cap the
    //     ATTR_WEIGHTS comment is about;
    //   - female `red` is 2 (founder, 2026-08-23): redheads are a few percent of
    //     the real pool, so a third of the deck spent on them bought precision
    //     nobody could use.
    const belowFloor: Record<string, number> = { archetype: 3, red: 2 };
    for (const photos of [FEMALE_PHOTOS, MALE_PHOTOS]) {
      const keys = Object.keys(photos[0].attrs);
      for (const key of keys) {
        const counts: Record<string, number> = {};
        for (const p of photos) counts[p.attrs[key]] = (counts[p.attrs[key]] ?? 0) + 1;
        for (const [value, c] of Object.entries(counts)) {
          const floor = belowFloor[key] ?? belowFloor[value] ?? CONF_FULL;
          expect(c).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });
});

describe("age bands", () => {
  it("maps ages to the viewer's own band", () => {
    expect(ageBandFor(22)).toBe("a");
    expect(ageBandFor(28)).toBe("a");
    expect(ageBandFor(29)).toBe("b");
    expect(ageBandFor(37)).toBe("b");
    expect(ageBandFor(38)).toBe("c");
    expect(ageBandFor(46)).toBe("c");
  });
});

describe("set selection", () => {
  it("maps gender preference to the shown set(s)", () => {
    expect(setsForPreference("men")).toEqual(["male"]);
    expect(setsForPreference("women")).toEqual(["female"]);
    expect(setsForPreference("both")).toEqual(["female", "male"]);
  });

  it("hides the beard chip from the female set", () => {
    expect(reasonChipsFor("female", "like").some((c) => c.id === "beard")).toBe(false);
    expect(reasonChipsFor("male", "like").some((c) => c.id === "beard")).toBe(true);
  });
});

// ── Preference math ─────────────────────────────────────────────────────────

const like = (photoId: string, chipId?: string): RadarAnswer => ({ photoId, verdict: "like", chipId });
const dislike = (photoId: string, chipId?: string): RadarAnswer => ({ photoId, verdict: "dislike", chipId });

describe("buildPreferenceVector", () => {
  it("learns a positive weight for a consistently liked attribute value", () => {
    // Every long-haired female photo liked, every short-haired disliked.
    const answers: RadarAnswer[] = FEMALE_PHOTOS.map((p) =>
      p.attrs.hairLength === "long" ? like(p.id) : dislike(p.id),
    );
    const pref = buildPreferenceVector("female", answers);
    expect(pref.hairLength.long.score).toBe(1);
    expect(pref.hairLength.short.score).toBe(-1);
    expect(pref.hairLength.long.confidence).toBe(1);
    expect(pref.hairLength.long.weight).toBeGreaterThan(0);
  });

  it("ignores answers for the other set", () => {
    const pref = buildPreferenceVector("female", [like("mp1"), dislike("mp2")]);
    expect(hasTypeSignal(pref)).toBe(false);
  });

  it("shrinks weight toward zero when signal is thin", () => {
    // Only one photo answered: confidence for its values is 1/4.
    const pref = buildPreferenceVector("female", [like("fp1")]);
    expect(pref.hairColor.blonde.confidence).toBe(1 / CONF_FULL);
    expect(Math.abs(pref.hairColor.blonde.weight)).toBeLessThan(
      Math.abs(pref.hairColor.blonde.score),
    );
  });

  it("excludes a card from attribute learning when the face/bad-photo chip is tapped", () => {
    const withChip = buildPreferenceVector("female", [dislike("fp1", "face")]);
    // fp1 is the only observation; excluded ⇒ no directional signal, score 0.
    expect(withChip.hairColor.blonde.score).toBe(0);
    expect(withChip.hairColor.blonde.confidence).toBe(1 / CONF_FULL); // still shown
  });

  it("boosts the named attribute and discounts the rest on an attribute chip", () => {
    // fp1 and fp2 are both `polished`, so a like on one against a dislike on the
    // other cancels out — unless the like explicitly credits the archetype.
    const base = buildPreferenceVector("female", [like("fp1"), dislike("fp2")]);
    const credited = buildPreferenceVector("female", [like("fp1", "style"), dislike("fp2")]);
    expect(base.archetype.polished.score).toBe(0);
    expect(credited.archetype.polished.score).toBeGreaterThan(0);
  });

  it("treats wholeVibe and loggedOnly chips as a uniform update", () => {
    const plain = buildPreferenceVector("female", [like("fp1")]);
    const vibe = buildPreferenceVector("female", [like("fp1", "wholeVibe")]);
    expect(vibe.hairColor.blonde.score).toBe(plain.hairColor.blonde.score);
    expect(vibe.hairColor.blonde.weight).toBe(plain.hairColor.blonde.weight);
  });
});

describe("candidateTypeScore", () => {
  it("returns neutral 0.5 with no preference signal", () => {
    const pref = buildPreferenceVector("female", []);
    expect(candidateTypeScore(pref, { hairColor: "blonde" })).toBe(0.5);
  });

  it("returns neutral 0.5 when the candidate shares no scored attribute", () => {
    const pref = buildPreferenceVector(
      "female",
      FEMALE_PHOTOS.map((p) => (p.attrs.hairLength === "long" ? like(p.id) : dislike(p.id))),
    );
    // Candidate exposes only an attribute key absent from the vector.
    expect(candidateTypeScore(pref, { unknownKey: "x" })).toBe(0.5);
  });

  it("scores an on-type candidate above a neutral one", () => {
    const pref = buildPreferenceVector(
      "female",
      FEMALE_PHOTOS.map((p) => (p.attrs.hairColor === "blonde" ? like(p.id) : dislike(p.id))),
    );
    const onType = candidateTypeScore(pref, { hairColor: "blonde" });
    const offType = candidateTypeScore(pref, { hairColor: "brunette" });
    expect(onType).toBeGreaterThan(0.5);
    expect(offType).toBeLessThan(0.5);
    expect(onType).toBeGreaterThan(offType);
  });

  it("lets the archetype outweigh a single secondary tag", () => {
    // The founder-facing claim of v2 in one assertion: a candidate whose
    // ARCHETYPE the viewer likes but whose hair they dislike must still score
    // above one where those roles are reversed.
    const pref: PreferenceVector = {
      archetype: { polished: { score: 1, confidence: 1, weight: 1 } },
      hairColor: { blonde: { score: -1, confidence: 1, weight: -1 } },
    };
    const rightType = candidateTypeScore(pref, { archetype: "polished", hairColor: "blonde" });
    const flipped: PreferenceVector = {
      archetype: { polished: { score: -1, confidence: 1, weight: -1 } },
      hairColor: { blonde: { score: 1, confidence: 1, weight: 1 } },
    };
    const rightHair = candidateTypeScore(flipped, { archetype: "polished", hairColor: "blonde" });
    expect(rightType).toBeGreaterThan(0.5);
    expect(rightHair).toBeLessThan(0.5);
    expect(attributeWeight("archetype")).toBeGreaterThan(attributeWeight("hairColor"));
  });

  it("stays within [0,1]", () => {
    const pref = buildPreferenceVector(
      "female",
      FEMALE_PHOTOS.map((p) => like(p.id)),
    );
    for (const color of ["blonde", "brunette", "red"]) {
      const s = candidateTypeScore(pref, { hairColor: color });
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

// ── V_type multiplier ───────────────────────────────────────────────────────

describe("typePreferenceMultiplier (V_type)", () => {
  const set: RadarSet = "female";
  // Strong, clean signal: like every blonde, dislike everyone else.
  const blondeLover: RadarAnswer[] = FEMALE_PHOTOS.map((p) => ({
    photoId: p.id,
    verdict: p.attrs.hairColor === "blonde" ? "like" : "dislike",
  }));
  const pref = buildPreferenceVector(set, blondeLover);
  const blonde = FEMALE_PHOTOS.find((p) => p.attrs.hairColor === "blonde")!;
  const red = FEMALE_PHOTOS.find((p) => p.attrs.hairColor === "red")!;

  it("is a no-op (1.0) at floor >= 1 regardless of signal (shadow mode)", () => {
    expect(typePreferenceMultiplier(pref, blonde.attrs, 1)).toBe(1);
    expect(typePreferenceMultiplier(pref, red.attrs, 1)).toBe(1);
    // Out-of-range floor clamps to 1 → still a no-op.
    expect(typePreferenceMultiplier(pref, red.attrs, 1.5)).toBe(1);
  });

  it("is neutral (1.0) when the viewer has no directional signal", () => {
    const empty = buildPreferenceVector(set, []);
    expect(hasTypeSignal(empty)).toBe(false);
    expect(typePreferenceMultiplier(empty, blonde.attrs, 0.7)).toBe(1);
  });

  it("is neutral (1.0) when the candidate has zero overlapping tags", () => {
    // Male-only tag keys never appear in a female preference vector.
    const alien = { beard: "beard", nonexistentKey: "x" };
    expect(typeOverlapCount(pref, alien)).toBe(0);
    expect(typePreferenceMultiplier(pref, alien, 0.7)).toBe(1);
  });

  it("favors the preferred type over the anti-type, bounded by [floor, 1]", () => {
    const mBlonde = typePreferenceMultiplier(pref, blonde.attrs, 0.7);
    const mRed = typePreferenceMultiplier(pref, red.attrs, 0.7);
    expect(mBlonde).toBeGreaterThan(mRed);
    expect(mBlonde).toBeLessThanOrEqual(1);
    expect(mRed).toBeGreaterThanOrEqual(0.7);
  });

  it("clamps a negative floor to 0", () => {
    const m = typePreferenceMultiplier(pref, red.attrs, -0.5);
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThanOrEqual(1);
  });
});
