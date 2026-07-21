import type { Language } from "./types.js";

/**
 * Canonical instruction shown immediately after the Magic Prompt.
 * Shared by every onboarding engine and client-facing history renderer.
 */
export function contextDumpInstruction(
  language: Language | null | undefined,
): string {
  switch (language) {
    case "ru":
      return (
        "Gennety анализирует твои диалоги и на их основе подбирает кандидатов. " +
        "Чем больше контекста — от главных ценностей до мелких деталей, — " +
        "тем точнее твой психологический профиль. " +
        "Такой же глубокий опрос проходит каждый, так что совместимость пары — не случайность.\n\n" +
        "Скопируй промпт выше, вставь его в ChatGPT, Claude, Gemini или любой " +
        "другой AI-чат, а потом скинь мне полный ответ."
      );
    case "uk":
      return (
        "Gennety аналізує твої діалоги й на їх основі підбирає кандидатів. " +
        "Чим більше контексту — від головних цінностей до дрібних деталей, — " +
        "тим точніший твій психологічний профіль. " +
        "Таке саме глибоке опитування проходить кожен, тож сумісність пари — не випадковість.\n\n" +
        "Скопіюй промпт вище, встав його в ChatGPT, Claude, Gemini або будь-який " +
        "інший AI-чат, а потім надішли мені повну відповідь."
      );
    case "de":
      return (
        "Gennety analysiert deine Gespräche und schlägt auf dieser Grundlage " +
        "Kandidaten vor. Je mehr Kontext du gibst — von grundlegenden Werten bis zu " +
        "kleinen Details —, desto genauer wird dein psychologisches Profil. " +
        "Dieselbe tiefe Befragung durchläuft jeder — Kompatibilität ist hier kein Zufall.\n\n" +
        "Kopiere den Prompt oben, füge ihn in ChatGPT, Claude, Gemini oder einen " +
        "anderen AI-Chat ein und schick mir danach die vollständige Antwort."
      );
    case "pl":
      return (
        "Gennety analizuje Twoje rozmowy i na ich podstawie dobiera kandydatów. " +
        "Im więcej kontekstu — od fundamentalnych wartości po drobne szczegóły — " +
        "tym dokładniejszy Twój profil psychologiczny. " +
        "Tę samą pogłębioną ankietę przechodzi każdy, więc dopasowanie pary to nie przypadek.\n\n" +
        "Skopiuj prompt powyżej, wklej go do ChatGPT, Claude, Gemini albo innego " +
        "czatu AI, a potem wyślij mi pełną odpowiedź."
      );
    default:
      return (
        "Gennety analyzes your conversations and picks your dates based on what it learns. " +
        "The more context you give — from core values down to small details — " +
        "the sharper your psychological profile. " +
        "We interview all other users in exactly the same way, so compatibility here isn't luck.\n\n" +
        "Copy the prompt above, paste it into ChatGPT, Claude, Gemini, or any other " +
        "AI chat, and then send me the full response."
      );
  }
}
