import type { StylePicksDigest } from "@gennety/shared";
import type { StyleCatalogItem } from "../catalog.js";
import type { StyleDigestSource } from "../digest.js";

/** Shared fixtures for the Vibe Check tests (not a test file itself). */

export function item(id: string, over: Partial<StyleCatalogItem> = {}): StyleCatalogItem {
  return {
    id,
    category: "scent",
    brand: "Brand",
    name: `Name ${id}`,
    gender: "unisex",
    priceTier: 2,
    priceEUR: 50,
    notes: "notes",
    tags: ["urban"],
    url: `https://shop.example/${id}`,
    urlUA: null,
    imageUrl: null,
    sponsored: false,
    affiliateParams: null,
    badges: [],
    active: true,
    ...over,
  };
}

export function digest(over: Partial<StylePicksDigest> = {}): StylePicksDigest {
  return {
    gender: "man",
    lookingFor: "women",
    ageBand: "22-25",
    archetype: "polished",
    tempo: "calm",
    focus: null,
    socialRole: null,
    anchors: [],
    hobbies: [],
    places: [],
    placeVibes: [],
    about: null,
    answers: [],
    ...over,
  };
}

export function source(over: Partial<StyleDigestSource> = {}): StyleDigestSource {
  return {
    gender: "male",
    preference: "women",
    age: 23,
    profile: {
      appearanceTags: { archetype: "polished", hairColor: "dark", beard: "clean", tattoos: "no" },
      energyAxis: -0.6,
      orientationAxis: 0.1,
      socialRole: "observer",
      anchorTags: ["food", "music", "ideas"],
      hobbies: ["tennis", "film photography"],
      psychologicalSummary: "Quiet, curious, likes slow evenings in wine bars and long walks.",
    },
    answers: [
      { questionId: "m_chronotype", answerText: "Night owl, definitely" },
      { questionId: "m_media", answerText: "Listening to Radiohead on repeat" },
    ],
    places: [
      { category: "lounge", vibeTags: ["cozy", "date-night"] },
      { category: "restaurant", vibeTags: ["cozy"] },
    ],
    ...over,
  };
}
