import { describe, expect, it } from "vitest";
import { fetchGoogleReviews, loadPlaceReviews, PLACE_REVIEWS_FIELD_MASK, selectReviews, trimAtSentence, type GoogleReview } from "./place-reviews.js";

/**
 * The `reviews` scene's board (founder, 2026-11-26): Google's own text, cut
 * only at a sentence, chosen by the server; the author as Google gives it;
 * one Place Details request in the person's language, never cached.
 */

const NOW = new Date("2026-11-26T12:00:00Z");

function review(over: Partial<GoogleReview> & { body?: string; name?: string; ago?: number } = {}): GoogleReview {
  const { body, name, ago, ...rest } = over;
  return {
    rating: 5,
    relativePublishTimeDescription: "2 недели назад",
    publishTime: new Date(NOW.getTime() - (ago ?? 14) * 86_400_000).toISOString(),
    text: { text: body ?? "Уютная веранда, приятно посидеть вечером. Вкусная кухня и хорошее вино, вернёмся ещё.", languageCode: "ru" },
    originalText: { text: body ?? "x", languageCode: "ru" },
    authorAttribution: { displayName: name ?? "Olena Kovalenko", uri: "https://www.google.com/maps/contrib/1", photoUri: "https://lh3.googleusercontent.com/a" },
    googleMapsUri: "https://www.google.com/maps/reviews/data=1",
    ...rest,
  };
}

describe("trimAtSentence", () => {
  it("short text stays whole, spaces collapsed", () => {
    expect(trimAtSentence("  Очень   уютно.\nВернёмся. ")).toBe("Очень уютно. Вернёмся.");
  });

  it("long text is cut after the last whole sentence that fits", () => {
    const text = `${"Первое предложение про веранду и вид на город. ".repeat(4)}Последнее очень длинное предложение, которое уже никак не влезает в лимит.`;
    const out = trimAtSentence(text, 220)!;
    expect([...out].length).toBeLessThanOrEqual(220);
    expect(out.endsWith("город.")).toBe(true);
    expect(text.startsWith(out)).toBe(true);
  });

  it("never mid-sentence: no sentence end within the limit → null; a decimal point is no end", () => {
    expect(trimAtSentence("а".repeat(300), 220)).toBeNull();
    expect(trimAtSentence(`Рейтинг 4.5 и ${"б".repeat(250)}. Ок.`, 220)).toBeNull();
  });

  it("ends with «!», «?», «…» and closing quotes count", () => {
    const text = `Это «лучшее место!» ${"в".repeat(10)} Отлично… ${"г".repeat(230)}.`;
    expect(trimAtSentence(text, 220)).toBe(`Это «лучшее место!» ${"в".repeat(10)} Отлично…`);
  });
});

describe("selectReviews", () => {
  it("2–3 reviews, Google's words, the author exactly as Google shows it", () => {
    const out = selectReviews([review(), review({ name: "Max Petrenko" }), review({ name: "Ira" }), review({ name: "Oleh" })], NOW);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      author: "Olena Kovalenko",
      rating: 5,
      text: "Уютная веранда, приятно посидеть вечером. Вкусная кухня и хорошее вино, вернёмся ещё.",
      when: "2 недели назад",
      source: "google",
      authorUri: "https://www.google.com/maps/contrib/1",
      authorPhotoUri: "https://lh3.googleusercontent.com/a",
      reviewUri: "https://www.google.com/maps/reviews/data=1",
      translated: false,
    });
  });

  it("fewer than two usable: none — the scene is refused", () => {
    expect(selectReviews([review()], NOW)).toEqual([]);
    expect(selectReviews([review(), review({ body: "Норм." })], NOW)).toEqual([]);
    expect(selectReviews(null, NOW)).toEqual([]);
  });

  it("unusable: no author, rating under 3, too short, nothing to cut at", () => {
    const out = selectReviews(
      [
        review({ authorAttribution: {} }),
        review({ rating: 2, name: "Low" }),
        review({ body: "Коротко и ясно, хорошо.", name: "Short" }),
        review({ body: "д".repeat(400), name: "Wall" }),
        review({ name: "A" }),
        review({ name: "B" }),
      ],
      NOW,
    );
    expect(out.map((r) => r.author)).toEqual(["A", "B"]);
  });

  it("4★+ first; then the room and the food over service complaints; then the recent", () => {
    const service = "Официант грубил, обслуживание долго, ждали счет минут сорок, администратор не помог совсем.";
    const out = selectReviews(
      [
        review({ rating: 3, name: "Three" }),
        review({ body: service, name: "Service" }),
        review({ name: "Old", ago: 700 }),
        review({ name: "Fresh", ago: 3 }),
      ],
      NOW,
    );
    expect(out.map((r) => r.author)).toEqual(["Fresh", "Old", "Service"]);
  });

  it("a 3★ fills in only when 4★+ are too few", () => {
    expect(selectReviews([review({ name: "Five" }), review({ rating: 3, name: "Three" })], NOW).map((r) => r.author)).toEqual(["Five", "Three"]);
  });

  it("written in their language beats translated by Google", () => {
    const translated = review({ name: "Translated", originalText: { text: "x", languageCode: "uk" } });
    const out = selectReviews([translated, review({ name: "Own" })], NOW);
    expect(out.map((r) => [r.author, r.translated])).toEqual([["Own", false], ["Translated", true]]);
  });
});

describe("fetchGoogleReviews", () => {
  it("one Place Details request: reviews only, in their language", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ reviews: [review(), review({ name: "Max" })] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await loadPlaceReviews("ChIJ x", "uk", NOW, { apiKey: "key", fetchFn });
    expect(out.map((r) => r.author)).toEqual(["Olena Kovalenko", "Max"]);
    expect(calls).toEqual([
      { url: "https://places.googleapis.com/v1/places/ChIJ%20x?languageCode=uk", headers: { "X-Goog-Api-Key": "key", "X-Goog-FieldMask": "reviews" } },
    ]);
    expect(PLACE_REVIEWS_FIELD_MASK).toBe("reviews");
  });

  it("no key, no place, an error or a throw: null, never a guess", async () => {
    const never = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    expect(await fetchGoogleReviews("p", "ru", { apiKey: null, fetchFn: never })).toBeNull();
    expect(await fetchGoogleReviews(null, "ru", { apiKey: "k", fetchFn: never })).toBeNull();
    const refused = (async () => new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), { status: 403 })) as unknown as typeof fetch;
    expect(await fetchGoogleReviews("p", "ru", { apiKey: "k", fetchFn: refused })).toBeNull();
    expect(await fetchGoogleReviews("p", "ru", { apiKey: "k", fetchFn: never })).toBeNull();
    const empty = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchGoogleReviews("p", "ru", { apiKey: "k", fetchFn: empty })).toEqual([]);
  });
});
