/**
 * Profiler answer intent (PRODUCT_SPEC §Phase 1b).
 *
 * The Profiler router captures free text as the answer to the live question and
 * `recordProfilerAnswer` writes it verbatim. That is right for an answer and
 * wrong for a refusal: "не хочу отвечать" was stored as the ANSWER to "what are
 * you watching right now?", marked `skipped: false` — so the question was burned
 * for good (answered questions are never re-asked) and the text went on to fuel
 * ice-breakers and wingman hints, where the bot could hand a partner "не хочу
 * отвечать" as if it were an interest.
 *
 * This module answers only the narrow question the router needs before it
 * writes: is this whole message a refusal to answer, rather than an answer?
 *
 * Deterministic on purpose. The classification runs on every Profiler reply, so
 * an LLM here would put a network call in the hot path of an ordinary chat
 * message; and the failure mode is asymmetric — a missed refusal degrades to
 * today's behaviour, while a false positive silently discards a real answer.
 * Exact whole-utterance matching makes the second impossible.
 */

/**
 * Whole utterances that decline to answer, per language.
 *
 * **Bare negatives are deliberately absent** — "no" / "нет" / "ні" / "nein" /
 * "nie" are legitimate ANSWERS to a large part of the question bank ("do you
 * play any sport?", "are you a morning person?"), so treating them as refusals
 * would throw away real signal. Only phrases that cannot plausibly answer a
 * "tell me about yourself" question are listed.
 */
const PROFILER_REFUSAL_PHRASES: readonly string[] = [
  // en
  "skip", "skip it", "skip this", "skip this one", "pass", "no thanks",
  "no thank you", "not now", "later", "maybe later", "don't want to",
  "dont want to", "i don't want to", "i dont want to", "i don't want to answer",
  "i dont want to answer", "rather not", "i'd rather not", "id rather not",
  "not answering", "no comment", "next question", "next one", "stop asking",
  "leave me alone", "don't ask", "dont ask",
  // ru
  "пропустить", "пропусти", "пропускаю", "пропуск", "не хочу",
  "не хочу отвечать", "не хочу говорить", "не буду отвечать", "не буду",
  "не отвечу", "не скажу", "без комментариев", "не сейчас", "потом", "позже",
  "как-нибудь потом", "следующий вопрос", "дальше", "отстань", "отстаньте",
  "не задавай", "не спрашивай", "хватит вопросов", "не твоё дело",
  "не твое дело",
  // uk
  "пропустити", "пропусти", "пропускаю", "не хочу", "не хочу відповідати",
  "не хочу говорити", "не буду відповідати", "не буду", "не скажу",
  "без коментарів", "не зараз", "потім", "пізніше", "наступне питання",
  "далі", "відчепись", "не питай", "не запитуй", "досить питань",
  // de
  "überspringen", "uberspringen", "skip", "will nicht", "ich will nicht",
  "keine lust", "nicht jetzt", "später", "spater", "kein kommentar",
  "nächste frage", "nachste frage", "lass mich in ruhe", "hör auf", "hor auf",
  "frag nicht",
  // pl
  "pomiń", "pomin", "pomijam", "nie chcę", "nie chce", "nie chcę odpowiadać",
  "nie chce odpowiadac", "nie będę", "nie bede", "nie powiem", "bez komentarza",
  "nie teraz", "później", "pozniej", "następne pytanie", "nastepne pytanie",
  "zostaw mnie", "przestań", "przestan", "nie pytaj",
];

const PROFILER_REFUSAL_SET = new Set(PROFILER_REFUSAL_PHRASES);

/** Longest listed phrase is well under this; anything longer is real content. */
const MAX_REFUSAL_LEN = 40;

/**
 * True when the whole message declines to answer the live Profiler question.
 *
 * Matching is on the COMPLETE normalized utterance, never a substring: "не хочу
 * отвечать" is a refusal, while "не хочу в кино, а вот на концерт хочу" is an
 * answer that happens to open with the same two words.
 */
export function isProfilerRefusal(text: string): boolean {
  const normalized = text
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?…]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > MAX_REFUSAL_LEN) return false;

  return PROFILER_REFUSAL_SET.has(normalized);
}
