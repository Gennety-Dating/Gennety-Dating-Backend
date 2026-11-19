/**
 * Suggested replies under the agent's message (decision 2026-11-19,
 * `docs/product/domains/suggested-replies.md`). Limits, timings and the phrase
 * lists the gates read live here (AGENTS.md rule 8); the generation itself is
 * `apps/bot/src/services/suggested-replies.ts`.
 */

import type { Language } from "./types.js";

export const SUGGESTED_REPLY_KINDS = ["answer", "step", "clarify", "close"] as const;
export type SuggestedReplyKind = (typeof SUGGESTED_REPLY_KINDS)[number];

export const SUGGESTED_REPLIES = {
  /** Answer options for one question: at least two, at most three. */
  minAnswers: 2,
  maxAnswers: 3,
  /** Chips the model may return, before the exit is added. */
  maxModelChips: 3,
  /** Longest chip text, in characters (the shorter the better). */
  maxChipChars: 32,
  /** The exit joins the set once a chat has this many of the person's turns… */
  exitAfterTurns: 12,
  /** …or has been running this long. */
  exitAfterMs: 30 * 60 * 1000,
  /** Local hours when the exit is first and the set is cut (start inclusive, end exclusive). */
  nightFromHour: 23,
  nightToHour: 5,
  /** Shown-and-ignored sets in a row after which the chat gets no more chips. */
  ignoredInARowStop: 2,
  /** Hard cap of the chips model call. Past it, no chips. */
  modelTimeoutMs: 2500,
  /** How long `GET …/replies` waits for a call still in flight. */
  pollWaitMs: 3000,
  /** Agent rows the model reads before the reply (text only). */
  contextRows: 6,
  /** Share of people (by a stable hash) held out with no chips, for the comparison. */
  holdoutPercent: 10,
  /** Offline step counted within this window after a tap (Pulse). */
  offlineStepWindowMs: 7 * 24 * 60 * 60 * 1000,
  /** Output budget of the chips call. */
  maxOutputTokens: 160,
} as const;

/** The token a build lists in `X-Gennety-Chat-Cards` to receive chips. */
export const REPLIES_CARD_CLIENT_TOKEN = "replies";

/**
 * Goodbyes, thanks and «ok» (agent concept rule 6): the reply is one warm line
 * and nothing comes after it, so no chips. Matched on the person's whole turn,
 * lower-cased, with punctuation and emoji stripped. Short and literal on
 * purpose — the model's own verdict covers the rest.
 */
export const LEAVING_PHRASES: Record<Language, readonly string[]> = {
  ru: [
    "пока", "пока пока", "спасибо", "спасибо большое", "спс", "благодарю", "ок", "окей", "оке", "ок спасибо",
    "окей спасибо", "ладно", "ладно спасибо", "понял", "поняла", "понял спасибо", "поняла спасибо", "ясно",
    "я спать", "я спать пошёл", "я спать пошла", "пойду спать", "спать", "спокойной ночи", "доброй ночи", "до завтра", "всё", "все", "на сегодня всё",
    "на сегодня все", "хорошо", "хорошо спасибо", "договорились", "давай", "до связи",
  ],
  uk: [
    "бувай", "па", "дякую", "дякую дуже", "ок", "окей", "добре", "зрозумів", "зрозуміла", "ясно", "я спати",
    "піду спати", "на добраніч", "добраніч", "до завтра", "все", "на сьогодні все", "домовились",
  ],
  en: [
    "bye", "bye bye", "thanks", "thank you", "thx", "ty", "ok", "okay", "ok thanks", "okay thanks", "got it",
    "cool", "cool thanks", "good night", "night", "gn", "going to sleep", "off to bed", "see you", "see ya",
    "thats all", "that's all", "going to sleep", "go to sleep", "going to bed", "bedtime", "thats all for today", "that's all for today", "sounds good", "deal",
  ],
  de: [
    "tschüss", "tschüs", "ciao", "danke", "danke schön", "vielen dank", "ok", "okay", "ok danke", "alles klar",
    "verstanden", "gute nacht", "ich geh schlafen", "bis morgen", "das wars", "das war's", "passt",
  ],
  pl: [
    "pa", "na razie", "dzięki", "dziękuję", "ok", "okej", "ok dzięki", "jasne", "rozumiem", "dobranoc",
    "idę spać", "do jutra", "to wszystko", "na dziś tyle", "spoko", "dobra",
  ],
};

/**
 * Continuation hooks no chip may carry, in any supported language (spec
 * Phase 1 point 4). A chip whose normalised text contains one of these is
 * dropped by code, whatever the model said.
 */
export const HOOK_FRAGMENTS: readonly string[] = [
  // ru / uk
  "ещё одн", "еще одн", "ещё истори", "еще истори", "расскажи ещё", "расскажи еще", "расскажи больше",
  "давай ещё", "давай еще", "что ещё", "что еще", "а дальше", "что дальше", "удиви", "продолжай",
  "ще одну", "ще історі", "розкажи ще", "розкажи більше", "а що далі", "що ще",
  // en
  "tell me more", "another one", "another story", "one more", "what else", "go on", "surprise me", "keep going",
  // de
  "erzähl mehr", "erzähl weiter", "noch eine", "noch einen", "was noch", "mach weiter",
  // pl
  "powiedz więcej", "powiedz jeszcze", "jeszcze jedn", "co jeszcze", "co dalej", "zaskocz",
];

/**
 * Words of feeling, consent or a paid step no chip may put in the person's
 * mouth (spec Phase 1 point 4). Same matching as {@link HOOK_FRAGMENTS}. A
 * preference about a place («мне нравится тихо») is fine; a feeling about a
 * person is not.
 */
export const VOICE_FRAGMENTS: readonly string[] = [
  "влюб", "он мне нравится", "она мне нравится", "мне он нравится", "мне она нравится", "люблю его", "люблю её",
  "люблю ее", "согласен", "согласна", "да давай поменяем", "давай поменяем", "закохан", "він мені подобається",
  "вона мені подобається", "кохаю", "згоден", "згодна", "in love", "i like him", "i like her", "i love him",
  "i love her", "i agree", "yes change", "verliebt", "ich mag ihn", "ich mag sie", "einverstanden", "zakochan",
  "podoba mi się on", "zgadzam",
  "premium", "преміум", "премиум", "билет", "квиток", "ticket", "bilet", "promo", "промо",
];

/** Lower-case, strip punctuation and emoji, collapse spaces. */
export function normalizeChipText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that only pad a goodbye («ок, спасибо, я спать»): dropped before the phrase match. */
const LEAVING_FILLER = new Set([
  "ок", "окей", "оке", "ну", "ладно", "хорошо", "спасибо", "спс", "понял", "поняла", "ясно", "всё", "все", "тогда",
  "добре", "дякую", "зрозумів", "зрозуміла",
  "ok", "okay", "k", "well", "alright", "cool", "thanks", "thank", "you", "thx", "ty", "so", "then", "got", "it",
  "danke", "gut", "alles", "klar", "dzięki", "dziękuję", "dobra", "spoko",
]);

/** Is this whole turn a goodbye, a thanks or an «ok» (agent concept rule 6)? */
export function isLeavingTurn(text: string): boolean {
  const norm = normalizeChipText(text);
  if (!norm || norm.length > 40) return false;
  const phrases = Object.values(LEAVING_PHRASES);
  if (phrases.some((list) => list.includes(norm))) return true;
  // «ок спасибо», «ok going to sleep thanks»: padding around a goodbye, or padding alone.
  const core = norm.split(" ").filter((word) => !LEAVING_FILLER.has(word)).join(" ");
  if (!core) return true;
  return phrases.some((list) => list.includes(core));
}

/** Does this chip text carry a hook or words the person did not think? */
export function chipTextForbidden(text: string): boolean {
  const norm = ` ${normalizeChipText(text)} `;
  return [...HOOK_FRAGMENTS, ...VOICE_FRAGMENTS].some((frag) => norm.includes(frag.toLowerCase()));
}
