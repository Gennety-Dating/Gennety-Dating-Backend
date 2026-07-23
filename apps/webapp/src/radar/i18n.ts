// Type Radar Mini App copy. The active language comes from `?lang=` on the URL
// the bot builds (same convention as the other Mini Apps); chip labels are keyed
// by the shared reason-chip id (the API sends ids only — see routes/radar.ts).
import type { Lang } from "../i18n.js";

export interface RadarStrings {
  title: string;
  subtitle: string;
  myType: string;
  notMyType: string;
  whyOptional: string;
  skipChip: string;
  preparing: string;
  finishing: string;
  doneTitle: string;
  doneBody: string;
  loadError: string;
  retry: string;
  progress: (done: number, total: number) => string;
  chips: Record<string, string>;
}

const CHIPS_EN = {
  face: "The face",
  figure: "The figure",
  hair: "The hair",
  style: "The style",
  tattoo: "Tattoos",
  beard: "The beard",
  wholeVibe: "Whole vibe",
  tooFlashy: "Too flashy",
  badPhoto: "Bad photo",
};

const STRINGS: Record<Lang, RadarStrings> = {
  en: {
    title: "Choose your type",
    subtitle: "Tap through — this only tunes who we show you. Nobody sees this.",
    myType: "My type",
    notMyType: "Not for me",
    whyOptional: "What caught your eye? (optional)",
    skipChip: "Skip",
    preparing: "Getting your cards ready…",
    finishing: "Saving your taste…",
    doneTitle: "All set",
    doneBody: "We've saved your preferences and we'll use them to find your matches.",
    loadError: "Couldn't load the cards.",
    retry: "Try again",
    progress: (d, t) => `${d} / ${t}`,
    chips: CHIPS_EN,
  },
  ru: {
    title: "Выбери свой типаж",
    subtitle: "Просто тапай — это лишь настраивает, кого показывать. Этого никто не видит.",
    myType: "Мой типаж",
    notMyType: "Не моё",
    whyOptional: "Что зацепило? (необязательно)",
    skipChip: "Пропустить",
    preparing: "Готовим карточки…",
    finishing: "Сохраняем твой вкус…",
    doneTitle: "Готово",
    doneBody: "Мы сохранили твои предпочтения и учтём их, когда будем подбирать тебе пару.",
    loadError: "Не удалось загрузить карточки.",
    retry: "Ещё раз",
    progress: (d, t) => `${d} / ${t}`,
    chips: {
      face: "Лицо",
      figure: "Фигура",
      hair: "Волосы",
      style: "Стиль",
      tattoo: "Тату",
      beard: "Борода",
      wholeVibe: "Общий вайб",
      tooFlashy: "Слишком броско",
      badPhoto: "Плохое фото",
    },
  },
  uk: {
    title: "Обери свій типаж",
    subtitle: "Просто тапай — це лише налаштовує, кого показувати. Цього ніхто не бачить.",
    myType: "Мій типаж",
    notMyType: "Не моє",
    whyOptional: "Що зачепило? (необовʼязково)",
    skipChip: "Пропустити",
    preparing: "Готуємо картки…",
    finishing: "Зберігаємо твій смак…",
    doneTitle: "Готово",
    doneBody: "Ми зберегли твої вподобання й врахуємо їх, коли шукатимемо тобі пару.",
    loadError: "Не вдалося завантажити картки.",
    retry: "Ще раз",
    progress: (d, t) => `${d} / ${t}`,
    chips: {
      face: "Обличчя",
      figure: "Фігура",
      hair: "Волосся",
      style: "Стиль",
      tattoo: "Тату",
      beard: "Борода",
      wholeVibe: "Загальний вайб",
      tooFlashy: "Занадто броско",
      badPhoto: "Погане фото",
    },
  },
  de: {
    title: "Wähle deinen Typ",
    subtitle: "Einfach durchtippen — das steuert nur, wen wir dir zeigen. Sieht niemand.",
    myType: "Mein Typ",
    notMyType: "Nichts für mich",
    whyOptional: "Was hat dir gefallen? (optional)",
    skipChip: "Überspringen",
    preparing: "Karten werden vorbereitet…",
    finishing: "Wir speichern deinen Geschmack…",
    doneTitle: "Fertig",
    doneBody: "Wir haben deine Vorlieben gespeichert und beziehen sie in deine Matches ein.",
    loadError: "Karten konnten nicht geladen werden.",
    retry: "Erneut",
    progress: (d, t) => `${d} / ${t}`,
    chips: {
      face: "Gesicht",
      figure: "Figur",
      hair: "Haare",
      style: "Stil",
      tattoo: "Tattoos",
      beard: "Bart",
      wholeVibe: "Gesamt-Vibe",
      tooFlashy: "Zu auffällig",
      badPhoto: "Schlechtes Foto",
    },
  },
  pl: {
    title: "Wybierz swój typ",
    subtitle: "Po prostu stukaj — to tylko dostraja, kogo pokazujemy. Nikt tego nie widzi.",
    myType: "Mój typ",
    notMyType: "Nie moje",
    whyOptional: "Co przyciągnęło wzrok? (opcjonalnie)",
    skipChip: "Pomiń",
    preparing: "Przygotowujemy karty…",
    finishing: "Zapisujemy twój gust…",
    doneTitle: "Gotowe",
    doneBody: "Zapisaliśmy Twoje preferencje i uwzględnimy je przy dobieraniu par.",
    loadError: "Nie udało się wczytać kart.",
    retry: "Ponów",
    progress: (d, t) => `${d} / ${t}`,
    chips: {
      face: "Twarz",
      figure: "Figura",
      hair: "Włosy",
      style: "Styl",
      tattoo: "Tatuaże",
      beard: "Broda",
      wholeVibe: "Cały klimat",
      tooFlashy: "Zbyt krzykliwe",
      badPhoto: "Słabe zdjęcie",
    },
  },
};

export function radarStrings(lang: Lang): RadarStrings {
  return STRINGS[lang] ?? STRINGS.en;
}
