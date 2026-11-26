/**
 * Real Google reviews for the `reviews` place scene (founder, 2026-11-26;
 * spec `docs/product/domains/agent-place-scenes.md` phase 5).
 *
 * The model picks a venue; this module asks Google for that place's reviews
 * in the person's language and chooses 2–3 of them. Nothing here is written
 * by a model: the text is Google's, quoted verbatim or cut at a sentence.
 *
 * Google Maps Platform rules this follows (read 2026-11-26):
 * - Terms 3.2.3(a)(iii) and (b): no copying, saving or caching of user
 *   reviews; the Places API service terms (§15.3) allow caching only
 *   latitude/longitude, and the place ID may be kept indefinitely. So there
 *   is NO cache here — not in memory, not in the database. A scene stores the
 *   place ID and fetches the reviews again on every history read.
 * - Terms 3.2.2(b): attribution is shown and never modified, so the author
 *   name goes out exactly as Google gives it (not shortened), with
 *   `source: "google"`.
 * - Places policies: say how reviews were ordered and filtered — the scene's
 *   footnote does (`placeReviewsNotice`).
 *
 * Billing: a Place Details (New) request whose field mask holds `reviews`
 * bills the «Place Details Enterprise + Atmosphere» SKU (the highest field in
 * the mask sets the price) — $25 per 1 000 after 1 000 free a month
 * (Google's pricing page, read 2026-11-26).
 */
import { PLACE_REVIEWS, type Language } from "@gennety/shared";
import { formatPlacesError, readPlacesError } from "../utils/places-error.js";

const PLACES_TIMEOUT_MS = 8_000;
/** Only the reviews: every other field of the scene comes from our catalog. */
export const PLACE_REVIEWS_FIELD_MASK = "reviews";

/** One review as Places API (New) returns it — only the fields we read. */
export interface GoogleReview {
  rating?: number;
  relativePublishTimeDescription?: string;
  publishTime?: string;
  text?: { text?: string; languageCode?: string };
  originalText?: { text?: string; languageCode?: string };
  authorAttribution?: { displayName?: string; uri?: string; photoUri?: string };
  googleMapsUri?: string;
}

/**
 * A chosen review. `author`, `rating`, `text`, `when`, `source` are
 * `ChatPlaceReview`; the rest is attribution the contract does not carry yet
 * (the author's profile and avatar, the review on Google Maps) and is kept
 * for it, never sent today.
 */
export interface PlaceReview {
  author: string;
  rating: number | null;
  text: string;
  when: string | null;
  source: "google";
  authorUri: string | null;
  authorPhotoUri: string | null;
  reviewUri: string | null;
  translated: boolean;
}

/* ── cutting the text ───────────────────────────────────────────────────── */

const SENTENCE_END = /[.!?…]+["»”')]*/g;

/**
 * The text as it reads, or cut after the last full sentence that fits `max`
 * characters. Null when no sentence ends within `max`: a review is never cut
 * mid-sentence. Pure.
 */
export function trimAtSentence(raw: string, max: number = PLACE_REVIEWS.textMaxLen): string | null {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if ([...clean].length <= max) return clean;
  let best: string | null = null;
  for (const m of clean.matchAll(SENTENCE_END)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end < clean.length && !/\s/.test(clean[end]!)) continue; // «4.5», «т.е»
    const head = clean.slice(0, end);
    if ([...head].length > max) break;
    best = head;
  }
  return best;
}

/* ── choosing ───────────────────────────────────────────────────────────── */

/**
 * Word stems of what makes a place worth going to — sitting there, the room,
 * the food — and of complaints about service, in our five languages and
 * lower case. A stem matches anywhere in a word.
 */
const PLACE_WORDS = [
  // ru / uk
  "атмосфер", "уют", "затишн", "посид", "сидет", "сидіт", "интерьер", "інтер'єр", "інтерєр", "терас", "веранд",
  "вид на", "краєвид", "музык", "музик", "вкусн", "смачн", "кухн", "блюд", "страв", "десерт", "кофе", "кава",
  "каву", "вино", "коктейл", "завтрак", "сніданк", "ужин", "вечер", "вечір",
  // en
  "atmosphere", "cozy", "cosy", "vibe", "interior", "terrace", "view", "music", "delicious", "tasty", "food",
  "dish", "dessert", "coffee", "wine", "cocktail", "breakfast", "dinner", "evening",
  // pl
  "atmosfer", "klimat", "przytul", "wnętrz", "taras", "pyszn", "smaczn", "jedzen", "dani", "deser", "kaw",
  // de
  "gemütlich", "ambiente", "einricht", "lecker", "essen", "gericht", "nachtisch", "kaffee", "abend",
] as const;

const SERVICE_COMPLAINTS = [
  // ru / uk
  "обслуж", "обслуг", "официант", "офіціант", "ждали", "чекали", "долго", "довго", "хам", "груб", "администратор",
  "адміністратор", "не принес", "не принесл", "забыл", "забул", "счет", "рахунок",
  // en
  "service", "waiter", "waitress", "rude", "waited", "slow", "staff", "manager", "bill",
  // pl
  "obsług", "kelner", "czekali", "długo", "niemił",
  // de
  "bedienung", "kellner", "gewartet", "unfreundlich", "langsam",
] as const;

function hits(text: string, words: readonly string[]): number {
  return words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
}

const DAY_MS = 86_400_000;

/**
 * 2–3 reviews for the board, or an empty list when fewer than two are usable
 * (the caller refuses the scene). Pure.
 *
 * Usable: an author name (attribution is required), a rating of at least
 * `floorRating`, a text of `textMinLen`–`textMaxLen` characters after cutting
 * at a sentence. Order: a rating of `preferRating` or more first; then
 * reviews that talk about sitting there, the room or the food over ones about
 * the service; then the recent; then those written in the person's language
 * (not translated by Google).
 */
export function selectReviews(raw: readonly GoogleReview[] | null | undefined, now: Date): PlaceReview[] {
  const scored: Array<{ review: PlaceReview; score: number }> = [];
  for (const r of raw ?? []) {
    const author = r.authorAttribution?.displayName?.replace(/\s+/g, " ").trim();
    const rating = typeof r.rating === "number" && Number.isFinite(r.rating) ? Math.round(r.rating) : null;
    const source = r.text?.text ?? r.originalText?.text;
    if (!author || !source || rating === null || rating < PLACE_REVIEWS.floorRating || rating > 5) continue;
    const text = trimAtSentence(source);
    if (!text || [...text].length < PLACE_REVIEWS.textMinLen) continue;
    const lower = text.toLocaleLowerCase();
    const translated = Boolean(
      r.text?.languageCode && r.originalText?.languageCode && r.text.languageCode !== r.originalText.languageCode,
    );
    const published = r.publishTime ? Date.parse(r.publishTime) : NaN;
    const ageDays = Number.isFinite(published) ? Math.max(0, (now.getTime() - published) / DAY_MS) : 730;
    const score =
      (rating >= PLACE_REVIEWS.preferRating ? 1000 : 0) +
      Math.min(3, hits(lower, PLACE_WORDS)) * 10 -
      Math.min(3, hits(lower, SERVICE_COMPLAINTS)) * 15 +
      Math.max(0, 1 - ageDays / 730) * 20 +
      (translated ? 0 : 5);
    scored.push({
      score,
      review: {
        author: [...author].slice(0, PLACE_REVIEWS.authorMaxLen).join(""),
        rating,
        text,
        when: r.relativePublishTimeDescription?.trim() || null,
        source: "google",
        authorUri: r.authorAttribution?.uri ?? null,
        authorPhotoUri: r.authorAttribution?.photoUri ?? null,
        reviewUri: r.googleMapsUri ?? null,
        translated,
      },
    });
  }
  // Stable: Google's own order (most relevant first) breaks ties.
  const chosen = scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, PLACE_REVIEWS.max)
    .map((s) => s.review);
  return chosen.length >= PLACE_REVIEWS.min ? chosen : [];
}

/* ── asking Google ──────────────────────────────────────────────────────── */

export interface ReviewFetchDeps {
  apiKey?: string | null;
  fetchFn?: typeof fetch;
}

/**
 * The place's reviews from Place Details (New) in the person's language, or
 * null when Google could not be asked (no key, no place ID, an error). One
 * billed request («Place Details Enterprise + Atmosphere»). Never cached.
 */
export async function fetchGoogleReviews(
  placeId: string | null | undefined,
  language: Language,
  deps: ReviewFetchDeps = {},
): Promise<GoogleReview[] | null> {
  const apiKey = deps.apiKey === undefined ? process.env.PLACES_API_KEY : deps.apiKey;
  if (!apiKey || !placeId) return null;
  try {
    const res = await (deps.fetchFn ?? fetch)(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=${encodeURIComponent(language)}`,
      {
        method: "GET",
        headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": PLACE_REVIEWS_FIELD_MASK },
        signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.warn(`[place-reviews] lookup failed: ${formatPlacesError(res.status, await readPlacesError(res))}`);
      return null;
    }
    const body = (await res.json()) as { reviews?: GoogleReview[] };
    return Array.isArray(body.reviews) ? body.reviews : [];
  } catch (err) {
    console.warn("[place-reviews] lookup failed:", err instanceof Error ? err.name : "error");
    return null;
  }
}

/** Fetch and choose in one step: the board's reviews, or [] (refuse / degrade). */
export async function loadPlaceReviews(
  placeId: string | null | undefined,
  language: Language,
  now: Date,
  deps: ReviewFetchDeps = {},
): Promise<PlaceReview[]> {
  return selectReviews(await fetchGoogleReviews(placeId, language, deps), now);
}
