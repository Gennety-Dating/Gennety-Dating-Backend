import type { Language } from "@gennety/shared";

/**
 * Copy for the Type Radar onboarding gate (§Type Radar, step 5B): the chat
 * message that carries the `web_app` "choose your type" button + a Skip button,
 * shown once right before the Magic Prompt / photos step. Kept as plain strings
 * (not in the big shared i18n bundle) so the feature stays self-contained.
 */
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
      "Quick visual step before we finish — tap through a few photos so I learn your type. ~30 seconds, and it only tunes who I show you. Nobody else sees it.",
    button: "🫰 Choose my type",
    skip: "Skip for now",
  },
  ru: {
    intro:
      "Быстрый визуальный шаг перед финалом — пролистай пару фото, чтобы я понял твой типаж. ~30 секунд, влияет только на то, кого я тебе показываю. Этого никто не видит.",
    button: "🫰 Выбрать типаж",
    skip: "Пропустить",
  },
  uk: {
    intro:
      "Швидкий візуальний крок перед фіналом — гортни кілька фото, щоб я зрозумів твій типаж. ~30 секунд, впливає лише на те, кого я тобі показую. Цього ніхто не бачить.",
    button: "🫰 Обрати типаж",
    skip: "Пропустити",
  },
  de: {
    intro:
      "Kurzer visueller Schritt zum Schluss — tippe dich durch ein paar Fotos, damit ich deinen Typ lerne. ~30 Sekunden, steuert nur, wen ich dir zeige. Sieht sonst niemand.",
    button: "🫰 Meinen Typ wählen",
    skip: "Später",
  },
  pl: {
    intro:
      "Szybki krok wizualny na koniec — przewiń kilka zdjęć, żebym poznał twój typ. ~30 sekund, wpływa tylko na to, kogo ci pokazuję. Nikt inny tego nie widzi.",
    button: "🫰 Wybierz mój typ",
    skip: "Pomiń",
  },
};

export function typeRadarInviteCopy(
  lang: Language | null | undefined,
): TypeRadarInviteCopy {
  return COPY[(lang ?? "en") as Language] ?? COPY.en;
}
