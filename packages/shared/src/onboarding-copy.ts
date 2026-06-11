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
        "Скопируй Magic Prompt выше и вставь его в ChatGPT, Claude, Gemini или другой AI-чат, которым ты уже пользуешься.\n\n" +
        "Зачем это нужно: Gennety не свайпает людей наугад. Мы просим твой AI-чат собрать честный психологический профиль по тому, что он уже знает о тебе: ценности, стиль общения, интересы, паттерны и то, кто тебе реально подходит. Такой же глубокий разбор проходит каждый пользователь, поэтому матчинг сравнивает не анкеты из пары строк, а нормальный контекст.\n\n" +
        "Когда AI вернёт ответ, пришли его сюда полностью."
      );
    case "uk":
      return (
        "Скопіюй Magic Prompt вище і встав його в ChatGPT, Claude, Gemini або інший AI-чат, яким ти вже користуєшся.\n\n" +
        "Навіщо це потрібно: Gennety не свайпає людей навмання. Ми просимо твій AI-чат зібрати чесний психологічний профіль за тим, що він уже знає про тебе: цінності, стиль спілкування, інтереси, патерни й те, хто тобі справді підходить. Такий самий глибокий розбір проходить кожен користувач, тому матчинг порівнює не анкети з кількох рядків, а нормальний контекст.\n\n" +
        "Коли AI поверне відповідь, надішли її сюди повністю."
      );
    case "de":
      return (
        "Kopiere den Magic Prompt oben und füge ihn in ChatGPT, Claude, Gemini oder einen anderen AI-Chat ein, den du bereits nutzt.\n\n" +
        "Warum das wichtig ist: Gennety matcht Menschen nicht zufällig per Swipe. Wir bitten deinen AI-Chat, aus dem vorhandenen Kontext ein ehrliches psychologisches Profil zu erstellen: Werte, Kommunikationsstil, Interessen, Muster und wer wirklich zu dir passt. Alle Nutzer durchlaufen dieselbe tiefe Analyse, damit das Matching nicht nur kurze Fragebögen, sondern echten Kontext vergleicht.\n\n" +
        "Wenn die AI antwortet, schick mir die vollständige Antwort hierher."
      );
    case "pl":
      return (
        "Skopiuj Magic Prompt powyżej i wklej go do ChatGPT, Claude, Gemini albo innego czatu AI, z którego już korzystasz.\n\n" +
        "Po co to robimy: Gennety nie dobiera ludzi losowo przez swipe. Prosimy Twój czat AI, żeby z istniejącego kontekstu stworzył szczery profil psychologiczny: wartości, styl komunikacji, zainteresowania, wzorce i to, kto naprawdę do Ciebie pasuje. Każdy użytkownik przechodzi taką samą pogłębioną analizę, więc matching porównuje realny kontekst, a nie tylko krótką ankietę.\n\n" +
        "Gdy AI zwróci odpowiedź, wyślij ją tutaj w całości."
      );
    default:
      return (
        "Copy the Magic Prompt above and paste it into ChatGPT, Claude, Gemini, or any other AI chat you already use.\n\n" +
        "Why we do this: Gennety does not match people from a shallow swipe profile. We ask your AI chat to turn the context it already has about you into an honest psychological profile: values, communication style, interests, patterns, and the kind of person who would genuinely fit you. Every user goes through the same deep read, so matching compares real context rather than a few questionnaire lines.\n\n" +
        "When the AI returns its answer, send the full response back here."
      );
  }
}
