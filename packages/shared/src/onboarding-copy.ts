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
        "Gennety использует подтверждённые сигналы из твоих диалогов, чтобы точнее подбирать кандидатов. " +
        "Промпт просит AI ничего не додумывать: если данных о какой-то стороне жизни нет, раздел останется пустым. " +
        "Такой же принцип действует для всех пользователей.\n\n" +
        "Скопируй промпт выше, вставь его в ChatGPT, Claude, Gemini или любой " +
        "другой AI-чат, а потом скинь мне полный ответ."
      );
    case "uk":
      return (
        "Gennety використовує підтверджені сигнали з твоїх діалогів, щоб точніше підбирати кандидатів. " +
        "Промпт просить AI нічого не вигадувати: якщо даних про певну сторону життя немає, розділ залишиться порожнім. " +
        "Той самий принцип діє для всіх користувачів.\n\n" +
        "Скопіюй промпт вище, встав його в ChatGPT, Claude, Gemini або будь-який " +
        "інший AI-чат, а потім надішли мені повну відповідь."
      );
    case "de":
      return (
        "Gennety nutzt belegte Signale aus deinen Gesprächen, um passendere Kandidaten vorzuschlagen. " +
        "Der Prompt weist die AI an, nichts zu ergänzen: Fehlen Informationen zu einem Lebensbereich, bleibt dieser Abschnitt leer. " +
        "Für alle Nutzer gilt dasselbe Prinzip.\n\n" +
        "Kopiere den Prompt oben, füge ihn in ChatGPT, Claude, Gemini oder einen " +
        "anderen AI-Chat ein und schick mir danach die vollständige Antwort."
      );
    case "pl":
      return (
        "Gennety wykorzystuje potwierdzone sygnały z Twoich rozmów, aby trafniej dobierać kandydatów. " +
        "Prompt prosi AI, by niczego nie dopowiadało: jeśli brakuje danych o danej sferze życia, sekcja pozostanie pusta. " +
        "Ta sama zasada obowiązuje wszystkich użytkowników.\n\n" +
        "Skopiuj prompt powyżej, wklej go do ChatGPT, Claude, Gemini albo innego " +
        "czatu AI, a potem wyślij mi pełną odpowiedź."
      );
    default:
      return (
        "Gennety uses supported signals from your conversations to make better matches. " +
        "The prompt tells your AI not to fill gaps: when a part of your life is not supported by the available history, that section stays empty. " +
        "The same rule applies to every user.\n\n" +
        "Copy the prompt above, paste it into ChatGPT, Claude, Gemini, or any other " +
        "AI chat, and then send me the full response."
      );
  }
}
