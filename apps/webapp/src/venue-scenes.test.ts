import { describe, expect, it } from "vitest";
import type { VenueIntentDraft } from "./api.js";
import { mergeSceneIntent, sceneOffers } from "./venue-scenes.js";
import copy from "./venue-scene-copy.json";

describe("native venue photo semantics", () => {
  it("puts recognized suggestions first and surprise last, without duplicates", () => {
    const offers = sceneOffers([
      { experiences: ["walk_view"], ambiences: ["scenic", "quiet"], formats: ["walking"] },
      { experiences: ["walk_view"], ambiences: ["lively"], formats: [] },
      { experiences: ["surprise_me"], ambiences: ["quiet"], formats: ["seated"] },
    ]);
    expect(offers.map((o) => o.scene.id)).toEqual(["walk", "coffee", "dinner", "wine", "surprise"]);
    expect(offers[0]!.mood).toEqual(["scenic", "quiet"]);
    expect(offers[4]!.ambiences).toEqual([]);
    expect(offers[4]!.formats).toEqual([]);
  });

  it("takes the chosen photo first, caps each axis at three, and preserves explicit setting", () => {
    const draft: VenueIntentDraft = {
      rawText: "outdoors, no alcohol", experiences: ["art_culture", "walk_view", "playful_activity"],
      ambiences: ["lively", "scenic"], formats: ["walking"], state: "draft", parserConfidence: 1,
      manualConfirmationRequired: true,
      hardConstraints: { dietary: ["vegan"], alcoholFree: true, stepFree: true, setting: "outdoor", maxPrice: "free", maxCommuteKm: 8 },
    };
    const merged = mergeSceneIntent(draft, sceneOffers([])[0], true);
    expect(merged.experiences).toEqual(["conversation", "coffee_treats", "art_culture"]);
    expect(merged.ambiences).toEqual(["quiet", "cozy_public", "lively"]);
    expect(merged.hardConstraints).toMatchObject({ setting: "outdoor", maxPrice: null, dietary: [], alcoholFree: false, stepFree: false });
    expect(draft.hardConstraints.maxPrice).toBe("free");
  });

  it("has the native title, own words label and all five scene titles in every language", () => {
    for (const strings of Object.values(copy)) {
      for (const key of ["venue.text.title", "venue.text.help", "venue.text.own", "venue.text.continue", "coffee", "dinner", "walk", "wine", "surprise"] as const) {
        expect(strings[key].trim().length).toBeGreaterThan(0);
      }
    }
  });
});
