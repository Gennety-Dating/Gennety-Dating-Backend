import { describe, it, expect } from "vitest";
import {
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
  CONF_FULL,
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

  it("balances every attribute value across at least two scenes (nuisance control)", () => {
    for (const photos of [FEMALE_PHOTOS, MALE_PHOTOS]) {
      const keys = Object.keys(photos[0].attrs);
      for (const key of keys) {
        const scenesByValue: Record<string, Set<string>> = {};
        for (const p of photos) {
          (scenesByValue[p.attrs[key]] ??= new Set()).add(p.scene);
        }
        for (const [, scenes] of Object.entries(scenesByValue)) {
          expect(scenes.size).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("shows each attribute value at least 4 times (confidence floor)", () => {
    for (const photos of [FEMALE_PHOTOS, MALE_PHOTOS]) {
      const keys = Object.keys(photos[0].attrs);
      for (const key of keys) {
        const counts: Record<string, number> = {};
        for (const p of photos) counts[p.attrs[key]] = (counts[p.attrs[key]] ?? 0) + 1;
        for (const [, c] of Object.entries(counts)) {
          expect(c).toBeGreaterThanOrEqual(CONF_FULL);
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
    const pref = buildPreferenceVector("female", [like("m01"), dislike("m02")]);
    expect(hasTypeSignal(pref)).toBe(false);
  });

  it("shrinks weight toward zero when signal is thin", () => {
    // Only one photo answered: confidence for its values is 1/4.
    const pref = buildPreferenceVector("female", [like("f01")]);
    expect(pref.hairColor.blonde.confidence).toBe(1 / CONF_FULL);
    expect(Math.abs(pref.hairColor.blonde.weight)).toBeLessThan(
      Math.abs(pref.hairColor.blonde.score),
    );
  });

  it("excludes a card from attribute learning when the face/bad-photo chip is tapped", () => {
    const withChip = buildPreferenceVector("female", [dislike("f01", "face")]);
    // f01 is the only observation; excluded ⇒ no directional signal, score 0.
    expect(withChip.hairColor.blonde.score).toBe(0);
    expect(withChip.hairColor.blonde.confidence).toBe(1 / CONF_FULL); // still shown
  });

  it("boosts the named attribute and discounts the rest on an attribute chip", () => {
    // Two conflicting cards on 'style', but one credits 'style' explicitly.
    const base = buildPreferenceVector("female", [like("f01"), dislike("f04")]);
    const credited = buildPreferenceVector("female", [like("f01", "style"), dislike("f04")]);
    // f01 style=elegant liked; crediting style should raise elegant's weight.
    expect(credited.style.elegant.score).toBeGreaterThan(base.style.elegant.score);
  });

  it("treats wholeVibe and loggedOnly chips as a uniform update", () => {
    const plain = buildPreferenceVector("female", [like("f01")]);
    const vibe = buildPreferenceVector("female", [like("f01", "wholeVibe")]);
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
