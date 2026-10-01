import type { Language } from "@gennety/shared";


export interface TypeRadarInviteCopy {
  /** Message body sent with the buttons. */
  intro: string;
  /** Label of the `web_app` button that opens the radar Mini App. */
  button: string;
  /** Label of the inline Skip button (callback `radar:skip`). */
  skip: string;
}

const COPY: Record<Language, TypeRadarInviteCopy> = {
  en: {
    intro:
      "Last step: flip through the photos and mark who you like — that's how I learn your type. Half a minute, and nobody will see it.",
    button: "🫰 Choose my type",
    skip: "Skip for now",
  },
  ru: {
    intro:
      "Последний шаг: полистай фото и отметь, кто нравится, — так я пойму твой типаж. Полминуты, никто этого не увидит.",
    button: "🫰 Выбрать типаж",
    skip: "Пропустить",
  },
  uk: {
    intro:
      "Останній крок: погортай фото й познач, хто подобається, — так я зрозумію твій типаж. Пів хвилини, ніхто цього не побачить.",
    button: "🫰 Обрати типаж",
    skip: "Пропустити",
  },
  de: {
    intro:
      "Letzter Schritt: Blättere durch die Fotos und markiere, wer dir gefällt — so lerne ich deinen Typ. Eine halbe Minute, und niemand sieht es.",
    button: "🫰 Meinen Typ wählen",
    skip: "Später",
  },
  pl: {
    intro:
      "Ostatni krok: przejrzyj zdjęcia i zaznacz, kto ci się podoba — tak poznam twój typ. Pół minuty, nikt tego nie zobaczy.",
    button: "🫰 Wybierz mój typ",
    skip: "Pomiń",
  },
};

export function typeRadarInviteCopy(
  lang: Language | null | undefined,
): TypeRadarInviteCopy {
  return COPY[(lang ?? "en") as Language] ?? COPY.en;
}
