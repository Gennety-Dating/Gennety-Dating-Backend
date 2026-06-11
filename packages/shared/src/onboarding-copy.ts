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
        "Gennety анализирует ваши диалоги и на их основе подбирает идеальных " +
        "кандидатов. Чем больше контекста вы даёте — от глобальных ценностей до " +
        "мелких деталей, — тем точнее ИИ формирует ваш психологический профиль. " +
        "Мы проводим такой же глубокий опрос для каждого пользователя, чтобы " +
        "гарантировать максимальную совместимость пары.\n\n" +
        "Скопируй промпт выше, вставь его в ChatGPT, Claude, Gemini или любой " +
        "другой AI-чат, а потом скинь мне полный ответ."
      );
    case "uk":
      return (
        "Gennety аналізує ваші діалоги й на їх основі підбирає ідеальних " +
        "кандидатів. Чим більше контексту ви даєте — від глобальних цінностей до " +
        "дрібних деталей, — тим точніше ШІ формує ваш психологічний профіль. " +
        "Ми проводимо таке саме глибоке опитування для кожного користувача, щоб " +
        "гарантувати максимальну сумісність пари.\n\n" +
        "Скопіюй промпт вище, встав його в ChatGPT, Claude, Gemini або будь-який " +
        "інший AI-чат, а потім надішли мені повну відповідь."
      );
    case "de":
      return (
        "Gennety analysiert deine Gespräche und schlägt auf dieser Grundlage ideale " +
        "Kandidaten vor. Je mehr Kontext du gibst — von grundlegenden Werten bis zu " +
        "kleinen Details —, desto genauer erstellt die KI dein psychologisches Profil. " +
        "Wir führen für jeden Nutzer dieselbe tiefgehende Befragung durch, um maximale " +
        "Kompatibilität des Paares zu gewährleisten.\n\n" +
        "Kopiere den Prompt oben, füge ihn in ChatGPT, Claude, Gemini oder einen " +
        "anderen AI-Chat ein und schick mir danach die vollständige Antwort."
      );
    case "pl":
      return (
        "Gennety analizuje Twoje rozmowy i na ich podstawie dobiera idealnych " +
        "kandydatów. Im więcej kontekstu podasz — od fundamentalnych wartości po " +
        "drobne szczegóły — tym dokładniej AI tworzy Twój profil psychologiczny. " +
        "Przeprowadzamy taką samą pogłębioną ankietę dla każdego użytkownika, aby " +
        "zapewnić maksymalne dopasowanie pary.\n\n" +
        "Skopiuj prompt powyżej, wklej go do ChatGPT, Claude, Gemini albo innego " +
        "czatu AI, a potem wyślij mi pełną odpowiedź."
      );
    default:
      return (
        "Gennety analyzes your conversations and selects potential dates based on " +
        "the information gathered. It performs best when it has more knowledge about " +
        "you and a diverse context of your life, capturing even the smallest details. " +
        "This analysis of your psychological profile helps in finding the most " +
        "suitable match for you. We interview all other users in exactly the same way.\n\n" +
        "Copy the prompt above, paste it into ChatGPT, Claude, Gemini, or any other " +
        "AI chat, and then send me the full response."
      );
  }
}
