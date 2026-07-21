import { generateVenueBlurbPrompt, type Language } from "@gennety/shared";
import { callOpenAIText } from "./openai.js";
import type { Venue } from "./venue.js";
import type { VenueCategory } from "./vibe-parser.js";

/**
 * Phase 3.7 — scheduled-card venue blurb.
 *
 * A 1–2 sentence, GROUNDED description of the chosen venue, shown on the
 * "date locked" card under the name + address (replacing the inlined Maps URL,
 * which already lives on the keyboard button). It lands at the emotional peak
 * of the flow, so trust matters more than flair: the model writes ONLY from the
 * facts we pass it (Google's editorial summary, rating, and category) and
 * never turns the pair's request into an unverified property of the place.
 *
 * Failsafe by construction: a missing OpenAI key, an empty/garbage completion,
 * or output that drifts from the contract all collapse to a per-language
 * generic fallback, so finalization never blocks on this.
 */

/** Generous-but-bounded: ~25 words target, reject anything clearly longer. */
const MAX_BLURB_CHARS = 180;

const FALLBACK: Record<Language, string> = {
  en: "A verified public place selected with both of your routes in mind.",
  ru: "Проверенное публичное место, выбранное с учётом ваших маршрутов.",
  uk: "Перевірене публічне місце, обране з урахуванням ваших маршрутів.",
  de: "Ein überprüfter öffentlicher Ort, ausgewählt mit Blick auf eure Wege.",
  pl: "Sprawdzone publiczne miejsce, wybrane z uwzględnieniem waszych tras.",
};

/**
 * Reject model output that drifts from the "1–2 short grounded sentences"
 * contract. Collapses internal whitespace, strips wrapping quotes, and bounces
 * questions / URL leaks. Returns the cleaned string on success, null on
 * rejection — callers then substitute the language fallback.
 */
function validateBlurb(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'«»“”]+|["'«»“”]+$/g, "")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > MAX_BLURB_CHARS) return null;
  if (cleaned.includes("?")) return null;
  if (/https?:\/\//i.test(cleaned)) return null;
  return cleaned;
}

export interface VenueBlurbInput {
  venue: Venue;
  category: VenueCategory;
  keywords: string[];
  language: Language;
}

/**
 * Generate the grounded venue blurb for one side, in their language. Always
 * resolves to a non-empty string (the fallback when generation is unavailable
 * or rejected), so callers can use it unconditionally.
 */
export async function generateVenueBlurb(input: VenueBlurbInput): Promise<string> {
  const { venue, category, keywords, language } = input;
  const systemPrompt = generateVenueBlurbPrompt({
    venueName: venue.name,
    category,
    primaryType: venue.primaryType ?? null,
    rating: venue.rating ?? null,
    userRatingCount: venue.userRatingCount ?? null,
    editorialSummary: venue.editorialSummary ?? null,
    keywords,
    language,
  });

  const text = await callOpenAIText(systemPrompt, "Write the venue blurb now.", {
    maxTokens: 90,
    temperature: 0.6,
  }).catch(() => "");

  return validateBlurb(text) ?? FALLBACK[language];
}
