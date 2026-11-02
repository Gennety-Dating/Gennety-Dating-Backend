import type { ScreenshotKind } from "@gennety/shared";

/**
 * A held-out set for the 2026-11 audit, written after the search was tuned and
 * never used to tune it (`labelled-set.ts` was). Entirely invented: no real
 * image, person, place or account. Each item is what an indexed row would hold.
 *
 * It aims at the cases the tuning set does not: two places of one name in two
 * cities, near-miss names, a typo, mixed languages, a screenshot with no text,
 * several things on one screenshot, and negatives whose honest answer is nothing.
 * `keywords` are what the agent would pass as names; `query` is its English line.
 */

export interface HoldoutItem {
  key: string;
  kind: ScreenshotKind;
  title: string;
  description: string;
  ocr: string;
}

export interface HoldoutQuery {
  query: string;
  keywords: readonly string[];
  /** Items an answer may contain. Empty: the honest answer is nothing. */
  relevant: readonly string[];
  /** What the query probes, for the report. */
  probe: "exact" | "meaning" | "typo" | "mixed-language" | "same-name" | "negative" | "multi";
}

export const HOLDOUT_ITEMS: readonly HoldoutItem[] = [
  { key: "rosa-kyiv", kind: "place", title: "Роза", description: "A small restaurant with pink walls, a map card in Kyiv.", ocr: "Роза ресторан Київ вул. Хрещатик 5 відкрито" },
  { key: "rosa-lviv", kind: "place", title: "Роза", description: "A cafe with a courtyard, a map card in Lviv.", ocr: "Роза кав'ярня Львів площа Ринок 3" },
  { key: "rosarium", kind: "place", title: "Rosarium Park", description: "A rose garden park with benches.", ocr: "Rosarium Park open daily" },
  { key: "pottery-studio", kind: "activity", title: "Глина", description: "A pottery studio offering a two-person wheel class.", ocr: "Глина гончарна майстерня заняття для двох" },
  { key: "ceramics-mug", kind: "item", title: "Handmade mug", description: "A handmade ceramic mug for sale in an online shop.", ocr: "Handmade ceramic mug 25 EUR add to cart" },
  { key: "berghain-poster", kind: "event", title: "Techno Night", description: "A techno party poster with a date.", ocr: "Techno Night Sa 15.11 23:00 Eintritt 15 EUR" },
  { key: "sushi-menu", kind: "food", title: "Sakura", description: "A sushi restaurant menu page with prices.", ocr: "Sakura sushi set 12 pieces 18 EUR" },
  { key: "interior-loft", kind: "aesthetic", title: "Loft", description: "A loft interior with brick walls, warm lamps and plants.", ocr: "" },
  { key: "mountain-view", kind: "aesthetic", title: "Mountains", description: "A landscape of snowy mountains at sunrise.", ocr: "" },
  { key: "two-things", kind: "place", title: "Weekend list", description: "A notes screenshot listing a bakery and a museum to visit.", ocr: "weekend: bakery Хлібня, museum Pinchuk Art Centre" },
  { key: "book-cover", kind: "media", title: "Норвезький ліс", description: "A book cover of a novel.", ocr: "Харукі Муракамі Норвезький ліс" },
  { key: "quote-note", kind: "text", title: "Quote", description: "A screenshot of a short quote on a plain background.", ocr: "Do what you can, with what you have, where you are" },
];

export const HOLDOUT_QUERIES: readonly HoldoutQuery[] = [
  { probe: "exact", query: "restaurant Rosa", keywords: ["Роза"], relevant: ["rosa-kyiv", "rosa-lviv"] },
  { probe: "same-name", query: "Rosa in Lviv", keywords: ["Роза", "Львів"], relevant: ["rosa-lviv", "rosa-kyiv"] },
  { probe: "exact", query: "pottery class", keywords: ["Глина"], relevant: ["pottery-studio"] },
  { probe: "mixed-language", query: "гончарна майстерня", keywords: [], relevant: ["pottery-studio"] },
  { probe: "meaning", query: "ceramics", keywords: [], relevant: ["pottery-studio", "ceramics-mug"] },
  { probe: "exact", query: "techno party", keywords: ["Techno Night"], relevant: ["berghain-poster"] },
  { probe: "typo", query: "sushi Sakra", keywords: ["Sakra"], relevant: ["sushi-menu"] },
  { probe: "meaning", query: "cosy interior with plants", keywords: [], relevant: ["interior-loft"] },
  { probe: "meaning", query: "mountains at sunrise", keywords: [], relevant: ["mountain-view"] },
  { probe: "multi", query: "bakery", keywords: ["Хлібня"], relevant: ["two-things"] },
  { probe: "multi", query: "museum", keywords: ["Pinchuk"], relevant: ["two-things"] },
  { probe: "mixed-language", query: "Murakami novel", keywords: ["Муракамі"], relevant: ["book-cover"] },
  { probe: "negative", query: "climbing gym", keywords: ["Boulderhaus"], relevant: [] },
  { probe: "negative", query: "wine bar with a terrace", keywords: [], relevant: [] },
  { probe: "negative", query: "car", keywords: [], relevant: [] },
  { probe: "negative", query: "hotel by the sea", keywords: ["Morskoy"], relevant: [] },
];
