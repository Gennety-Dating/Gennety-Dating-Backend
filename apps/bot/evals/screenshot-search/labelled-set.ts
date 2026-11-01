import type { ScreenshotKind } from "@gennety/shared";

/**
 * A labelled set for the screenshot library's search: the founder's nine lines,
 * three items each. Entirely invented. No real image, person, place or account:
 * each item is what an indexed row would hold, a description and recognised text.
 *
 * `relevant` are the items a query should find. A query with an empty list is a
 * negative: the honest answer is «nothing found», which is what the distance limit
 * is for. `line` is the founder's line number.
 */

export interface LabelledItem {
  key: string;
  line: number;
  kind: ScreenshotKind;
  title: string;
  description: string;
  ocr: string;
}

export interface LabelledQuery {
  query: string;
  relevant: readonly string[];
  note?: string;
}

export const LABELLED_ITEMS: readonly LabelledItem[] = [
  { key: "place-wine", line: 1, kind: "place", title: "Лоза", description: "A small wine bar with a green terrace and candles on the tables.", ocr: "Лоза винный бар ул. Садовая 12 терраса открыто до 23:00" },
  { key: "place-park", line: 1, kind: "place", title: "Botanic Garden", description: "A map pin on a botanical garden with long alleys and a pond.", ocr: "Botanic Garden 4.7 stars open 9-20 free entry" },
  { key: "place-hotel", line: 1, kind: "place", title: "Hotel Morskoy", description: "A seaside boutique hotel with a rooftop pool, booking page.", ocr: "Hotel Morskoy from 120 EUR per night rooftop pool sea view" },

  { key: "event-concert", line: 2, kind: "event", title: "Jazz на крыше", description: "A poster for an open-air jazz concert on a rooftop.", ocr: "Jazz на крыше 14 ноября 19:00 билеты от 500" },
  { key: "event-expo", line: 2, kind: "event", title: "Impressionists", description: "An art exhibition poster with a painting of water lilies.", ocr: "Impressionists exhibition 1 Oct - 30 Nov City Museum tickets" },
  { key: "event-workshop", line: 2, kind: "event", title: "Мастер-класс по акварели", description: "A listing for a watercolour workshop on a set date.", ocr: "Мастер-класс акварель суббота 22 ноября 12:00 запись" },

  { key: "activity-pottery", line: 3, kind: "activity", title: "Лепка вдвоём", description: "A video still of two people making clay bowls on a pottery wheel, an idea for a date.", ocr: "керамика вдвоём идея для свидания" },
  { key: "activity-picnic", line: 3, kind: "activity", title: "Sunset picnic", description: "A blanket with fruit and cheese in a field at sunset, picnic inspiration.", ocr: "10 picnic ideas for the perfect evening" },
  { key: "activity-cook", line: 3, kind: "activity", title: "Cook together", description: "Two aprons and a messy kitchen counter, an article about cooking together at home.", ocr: "cook together at home: date night ideas" },

  { key: "outfit-coat", line: 4, kind: "outfit", title: "Camel coat look", description: "A street style look: long camel coat, white sneakers and a black turtleneck.", ocr: "autumn outfit inspo camel coat" },
  { key: "outfit-dress", line: 4, kind: "outfit", title: "Чёрное платье", description: "A black slip dress with thin straps and gold jewellery on a model.", ocr: "платье-комбинация чёрное образ на вечер" },
  { key: "outfit-shoes", line: 4, kind: "outfit", title: "Chelsea boots", description: "Brown leather Chelsea boots shown from the side on a shop page.", ocr: "Chelsea boots brown leather size 42" },

  { key: "item-flowers", line: 5, kind: "item", title: "Пионы", description: "A bouquet of pale pink peonies in a florist's listing.", ocr: "букет пионы 15 шт доставка сегодня" },
  { key: "item-perfume", line: 5, kind: "item", title: "Santal perfume", description: "A bottle of woody sandalwood perfume on a shop page.", ocr: "Santal eau de parfum 50 ml add to cart" },
  { key: "item-mug", line: 5, kind: "item", title: "Handmade mug", description: "A speckled handmade ceramic mug with a wide handle, gift guide.", ocr: "handmade mug gift guide 18 EUR" },

  { key: "food-pasta", line: 6, kind: "food", title: "Паста с грибами", description: "A recipe card for mushroom pasta with cream, steps and a photo of the plate.", ocr: "паста с грибами сливки чеснок 30 минут рецепт" },
  { key: "food-menu", line: 6, kind: "food", title: "Sushi menu", description: "A restaurant menu page listing sushi rolls and prices.", ocr: "Menu philadelphia roll 14 dragon roll 16 miso soup 5" },
  { key: "food-salad", line: 6, kind: "food", title: "Green bowl", description: "A green salad bowl with avocado and chickpeas, no meat on the plate.", ocr: "avocado chickpea bowl 15 min recipe" },

  { key: "aesthetic-room", line: 7, kind: "aesthetic", title: "Cosy reading nook", description: "A dim room with a soft armchair, warm lamp and shelves, a quiet cosy mood.", ocr: "" },
  { key: "aesthetic-lake", line: 7, kind: "aesthetic", title: "Mountain lake", description: "A still mountain lake at dawn with mist, wide open nature and no people.", ocr: "" },
  { key: "aesthetic-hall", line: 7, kind: "aesthetic", title: "Grand hall", description: "A formal hall with chandeliers, gold mouldings and a long laid table.", ocr: "" },

  { key: "media-book", line: 8, kind: "media", title: "Мастер и Маргарита", description: "A book cover with a black cat on a bookshop page.", ocr: "Мастер и Маргарита Булгаков роман" },
  { key: "media-film", line: 8, kind: "media", title: "Lost in Translation", description: "A film page with a poster and a rating.", ocr: "Lost in Translation 2003 drama 7.7 watchlist" },
  { key: "media-music", line: 8, kind: "media", title: "Vinyl hobby", description: "A turntable and a stack of vinyl records, a page about collecting records.", ocr: "how to start a vinyl collection" },

  { key: "text-quote", line: 9, kind: "text", title: "Цитата о времени", description: "White text on a plain background, a quote about time.", ocr: "Время, которое ты с удовольствием потратил впустую, не потрачено зря" },
  { key: "text-note", line: 9, kind: "text", title: "Notes", description: "A phone note listing wishes for dates.", ocr: "хочу больше активных свиданий, меньше кафе" },
  { key: "text-list", line: 9, kind: "text", title: "Packing list", description: "A checklist in a notes app with items for a trip.", ocr: "passport charger sunscreen tickets" },
];

export const LABELLED_QUERIES: readonly LabelledQuery[] = [
  { query: "wine bar with a terrace", relevant: ["place-wine"] },
  { query: "a park to walk in", relevant: ["place-park"] },
  { query: "hotel by the sea", relevant: ["place-hotel"] },
  { query: "jazz concert", relevant: ["event-concert"] },
  { query: "art exhibition", relevant: ["event-expo"] },
  { query: "painting workshop", relevant: ["event-workshop"] },
  { query: "pottery date idea", relevant: ["activity-pottery"] },
  { query: "something to do outdoors at sunset", relevant: ["activity-picnic"] },
  { query: "cooking at home together", relevant: ["activity-cook"] },
  { query: "autumn coat outfit", relevant: ["outfit-coat"] },
  { query: "elegant black evening dress", relevant: ["outfit-dress"] },
  { query: "leather boots", relevant: ["outfit-shoes"] },
  { query: "flowers bouquet", relevant: ["item-flowers"] },
  { query: "perfume", relevant: ["item-perfume"] },
  { query: "ceramic gift", relevant: ["item-mug", "activity-pottery"] },
  { query: "pasta recipe", relevant: ["food-pasta"] },
  { query: "sushi", relevant: ["food-menu"] },
  { query: "healthy salad", relevant: ["food-salad"] },
  { query: "quiet cosy interior", relevant: ["aesthetic-room"] },
  { query: "nature landscape with a lake", relevant: ["aesthetic-lake"] },
  { query: "formal elegant hall", relevant: ["aesthetic-hall"] },
  { query: "novel with a black cat", relevant: ["media-book"] },
  { query: "drama film to watch", relevant: ["media-film"] },
  { query: "collecting vinyl records", relevant: ["media-music"] },
  { query: "quote about wasted time", relevant: ["text-quote"] },
  { query: "note about active dates", relevant: ["text-note"] },
  { query: "list of things for a trip", relevant: ["text-list"] },
  // In the person's own language, against an English description.
  { query: "винный бар с террасой", relevant: ["place-wine"] },
  { query: "уютная комната", relevant: ["aesthetic-room"] },
  // Nothing saved should answer these.
  { query: "car insurance renewal", relevant: [] },
  { query: "tax return deadline", relevant: [] },
  { query: "how to fix a leaking tap", relevant: [] },
  { query: "football league table", relevant: [] },
  { query: "cryptocurrency exchange rate", relevant: [] },
];
