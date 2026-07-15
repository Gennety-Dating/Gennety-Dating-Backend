/**
 * Match-card copy generator — the SHORT person-first text that fits the lead
 * card's panel (a vibe line + one compact paragraph), distinct from the long
 * streamed pitch. Language-aware; emoji-free by contract (the card fonts have
 * no color-emoji glyphs — see template.ts).
 *
 * Returns `null` on any failure or when no API key is configured: the card
 * copy must never be a generic template (that would defeat the whole point of
 * the card), so callers fall back to the plain photo media group instead.
 *
 * TODO: move the prompt to @gennety/shared prompts once the card flow
 * stabilizes (kept local while the feature is dev-flagged).
 */
import { env } from "../../config.js";
import { openaiFetch } from "../openai-fetch.js";
import { t, type Language } from "@gennety/shared";
import type { MatchCardTexts } from "./template.js";

const MODEL = "gpt-4.1-mini";
const MAX_TOKENS = 220;
const OPENAI_TIMEOUT_MS = 30_000;
const TAGLINE_MAX = 64;
const PARAGRAPH_MAX = 230;

export interface MatchCardCopyInput {
  partnerFirstName: string | null;
  partnerAge: number | null;
  partnerSummary: string | null;
  language: Language;
}

const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  pl: "Polish",
};

function stripEmoji(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").trim();
}

/** Truncate at a word boundary with an ellipsis, only when over `max`. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd();
  return `${atWord}…`;
}

function buildPrompt(input: MatchCardCopyInput): string {
  return [
    `You write the copy for a small dating match card. Respond in ${LANGUAGE_NAMES[input.language]}.`,
    `The card presents ${input.partnerFirstName ?? "the partner"} to the recipient.`,
    "Return STRICT JSON: {\"tagline\": string, \"paragraph\": string}.",
    `- tagline: one warm line about the person's vibe, max ${TAGLINE_MAX} characters, no name in it. Understatement over hype — plain and specific, never salesy.`,
    `- paragraph: max ${PARAGRAPH_MAX} characters, 2 short sentences describing who they are and what being around them feels like. Concrete, warm, grounded in the profile below. Never invent facts. Never try to sound cool — no slang, no hype adjectives.`,
    "- Address the reader informally (ты-form where the language has it), in a native casual register.",
    "- Describe the PERSON, never 'your date' / 'свидание с'. No emoji, no quotes, no lists.",
    "",
    `Profile notes: ${input.partnerSummary?.slice(0, 1500) ?? "(none)"}`,
  ].join("\n");
}

export async function generateMatchCardTexts(
  input: MatchCardCopyInput,
): Promise<MatchCardTexts | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const name = input.partnerFirstName?.trim();
  if (!name) return null;

  try {
    const res = await openaiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: MAX_TOKENS,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildPrompt(input) },
          { role: "user", content: "Generate the card copy now." },
        ],
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OpenAI card copy failed: ${res.status}`);
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string | null } }>;
    };
    const raw = json.choices[0]?.message?.content?.trim();
    if (!raw) throw new Error("OpenAI card copy returned empty content");
    const parsed = JSON.parse(raw) as { tagline?: unknown; paragraph?: unknown };
    const tagline = typeof parsed.tagline === "string" ? stripEmoji(parsed.tagline) : "";
    const paragraph = typeof parsed.paragraph === "string" ? stripEmoji(parsed.paragraph) : "";
    if (!tagline || !paragraph) throw new Error("OpenAI card copy missing fields");

    return {
      // Empty eyebrow → the panel opens with the wine accent bar (template.ts).
      eyebrow: "",
      name:
        input.partnerAge == null
          ? name
          : t(input.language, "matchPhotoCaption", { name, age: input.partnerAge }),
      tagline: clamp(tagline, TAGLINE_MAX),
      paragraphs: [clamp(paragraph, PARAGRAPH_MAX)],
      wordmark: "Gennety",
    };
  } catch (err) {
    console.warn("[match-card] copy generation failed:", err);
    return null;
  }
}
