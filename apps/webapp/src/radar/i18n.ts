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
  finishing: string;
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
};

const STRINGS: Record<Lang, RadarStrings> = {
  en: {
    title: "Choose your type",
    subtitle: "Tap through — this only tunes who we show you. Nobody sees this.",
    myType: "My type",
    notMyType: "Not for me",
    whyOptional: "What caught your eye? (optional)",
    skipChip: "Skip",
    finishing: "Saving your taste…",
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
    finishing: "Сохраняем твой вкус…",
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
    },
  },
  uk: {
    title: "Обери свій типаж",
    subtitle: "Просто тапай — це лише налаштовує, кого показувати. Цього ніхто не бачить.",
    myType: "Мій типаж",
    notMyType: "Не моє",
    whyOptional: "Що зачепило? (необовʼязково)",
    skipChip: "Пропустити",
    finishing: "Зберігаємо твій смак…",
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
    },
  },
  de: {
    title: "Wähle deinen Typ",
    subtitle: "Einfach durchtippen — das steuert nur, wen wir dir zeigen. Sieht niemand.",
    myType: "Mein Typ",
    notMyType: "Nichts für mich",
    whyOptional: "Was hat dir gefallen? (optional)",
    skipChip: "Überspringen",
    finishing: "Wir speichern deinen Geschmack…",
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
    },
  },
  pl: {
    title: "Wybierz swój typ",
    subtitle: "Po prostu stukaj — to tylko dostraja, kogo pokazujemy. Nikt tego nie widzi.",
    myType: "Mój typ",
    notMyType: "Nie moje",
    whyOptional: "Co przyciągnęło wzrok? (opcjonalnie)",
    skipChip: "Pomiń",
    finishing: "Zapisujemy twój gust…",
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
    },
  },
};

export function radarStrings(lang: Lang): RadarStrings {
  return STRINGS[lang] ?? STRINGS.en;
}
