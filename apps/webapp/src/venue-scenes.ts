import type { VenueAmbience, VenueExperience, VenueFormat, VenueIntentDraft, VenueIntentTmaState } from "./api.js";

type Scene = {
  id: "coffee" | "dinner" | "walk" | "wine" | "surprise";
  asset: string;
  focus: string;
  primary: VenueExperience;
  experiences: VenueExperience[];
  ambiences: VenueAmbience[];
  formats: VenueFormat[];
};
// Same five scenes, photos, crop anchors and facets as iOS VenueScene.swift.
export const SCENES: Scene[] = [
  { id: "coffee", asset: "venue-scene-coffee-window", focus: "50% 0%", primary: "coffee_treats", experiences: ["conversation", "coffee_treats"], ambiences: ["quiet", "cozy_public"], formats: ["seated", "indoor"] },
  { id: "dinner", asset: "venue-scene-dinner", focus: "50% 100%", primary: "meal_discovery", experiences: ["meal_discovery", "conversation"], ambiences: ["romantic_public", "cozy_public"], formats: ["seated", "indoor"] },
  { id: "walk", asset: "venue-scene-walk-river", focus: "50% 50%", primary: "walk_view", experiences: ["walk_view", "conversation"], ambiences: ["scenic", "quiet"], formats: ["walking", "outdoor"] },
  { id: "wine", asset: "venue-scene-wine-evening", focus: "50% 0%", primary: "drinks_evening", experiences: ["drinks_evening", "conversation"], ambiences: ["romantic_public", "cozy_public"], formats: ["seated", "indoor"] },
  { id: "surprise", asset: "venue-scene-surprise", focus: "50% 74%", primary: "surprise_me", experiences: ["surprise_me"], ambiences: [], formats: [] },
];
export type SceneOffer = { scene: Scene; ambiences: VenueAmbience[]; formats: VenueFormat[]; mood: VenueAmbience[] };

export function sceneOffers(suggestions: VenueIntentTmaState["suggestions"]): SceneOffer[] {
  const matched = new Map<Scene["id"], VenueIntentTmaState["suggestions"][number]>();
  const order: Scene[] = [];
  for (const suggestion of suggestions) {
    const scene = suggestion.experiences.map((id) => SCENES.find((s) => s.primary === id)).find(Boolean)
      ?? (suggestion.experiences.includes("conversation") ? SCENES[0] : undefined);
    if (!scene || matched.has(scene.id)) continue;
    matched.set(scene.id, suggestion);
    if (scene.id !== "surprise") order.push(scene);
  }
  order.push(...SCENES.filter((s) => s.id !== "surprise" && !order.includes(s)), SCENES[4]!);
  return order.map((scene) => {
    const suggestion = scene.id !== "surprise" ? matched.get(scene.id) : undefined;
    return {
      scene,
      ambiences: suggestion?.ambiences.length ? suggestion.ambiences.slice(0, 3) : scene.ambiences,
      formats: suggestion?.formats.length ? suggestion.formats.slice(0, 3) : scene.formats,
      mood: suggestion?.ambiences.slice(0, 2) ?? [],
    };
  });
}

const merge = <T>(base: T[], extra: T[]): T[] => [...new Set([...base, ...extra])].slice(0, 3);

export function mergeSceneIntent(draft: VenueIntentDraft, offer: SceneOffer | undefined, hasText: boolean): VenueIntentDraft {
  return {
    ...draft,
    experiences: offer ? merge(offer.scene.experiences, hasText ? draft.experiences : []) : draft.experiences,
    ambiences: offer ? merge(offer.ambiences, hasText ? draft.ambiences : []) : draft.ambiences,
    formats: offer ? merge(offer.formats, hasText ? draft.formats : []) : draft.formats,
    hardConstraints: { ...draft.hardConstraints, dietary: [], alcoholFree: false, stepFree: false, maxPrice: null },
  };
}
