/**
 * Self-contained i18n for the ticket store / wallet Mini App. The hero
 * Ticket3D card reuses the Date Ticket strings (../ticket/i18n) so its labels
 * stay consistent; everything store-specific lives here. Anonymized holder
 * names are used on the card (the store ticket is generic, not personalized).
 */

export type Lang = "en" | "ru" | "uk" | "de" | "pl";

export interface StoreStrings {
  title: string;
  sub: string;
  balance: string;
  perTicket: string;
  bestValue: string;
  /** Per-ticket saving badge on multi-ticket bundles. `{pct}` = whole percent. */
  save: string;
  buy: string;
  successTitle: string;
  successSub: string;
  done: string;
  processing: string;
  back: string;
  loading: string;
  errGeneric: string;
  /** Anonymized holder names printed on the store ticket card. */
  anonHolderA: string;
  anonHolderB: string;
}

const en: StoreStrings = {
  title: "Get Date Tickets 🎟️",
  sub: "One ticket = one date. Stock up so you're always ready.",
  balance: "Your wallet: {n} 🎟️",
  perTicket: "{amount} / ticket",
  bestValue: "Best value",
  save: "Save {pct}%",
  buy: "Buy {count} — {amount}",
  successTitle: "Tickets added 🎟️",
  successSub: "Your wallet now holds {n}. Use them when your next date is set.",
  done: "Done",
  processing: "Processing…",
  back: "← Back",
  loading: "Loading your wallet…",
  errGeneric: "Something went wrong. Reopen this from the bot.",
  anonHolderA: "Member",
  anonHolderB: "Your date",
};

const ru: StoreStrings = {
  title: "Билеты на свидания 🎟️",
  sub: "Один билет = одно свидание. Запасись, чтобы всегда быть готовым.",
  balance: "Твой кошелёк: {n} 🎟️",
  perTicket: "{amount} / билет",
  bestValue: "Выгоднее всего",
  save: "Скидка {pct}%",
  buy: "Купить {count} — {amount}",
  successTitle: "Билеты добавлены 🎟️",
  successSub: "Теперь в кошельке {n}. Используй их, когда назначишь свидание.",
  done: "Готово",
  processing: "Обработка…",
  back: "← Назад",
  loading: "Загружаем кошелёк…",
  errGeneric: "Что-то пошло не так. Открой заново из бота.",
  anonHolderA: "Участник",
  anonHolderB: "Твоя пара",
};

const uk: StoreStrings = {
  title: "Квитки на побачення 🎟️",
  sub: "Один квиток = одне побачення. Запасись, щоб завжди бути готовим.",
  balance: "Твій гаманець: {n} 🎟️",
  perTicket: "{amount} / квиток",
  bestValue: "Найвигідніше",
  save: "Знижка {pct}%",
  buy: "Купити {count} — {amount}",
  successTitle: "Квитки додано 🎟️",
  successSub: "Тепер у гаманці {n}. Використай їх, коли призначиш побачення.",
  done: "Готово",
  processing: "Обробка…",
  back: "← Назад",
  loading: "Завантажуємо гаманець…",
  errGeneric: "Щось пішло не так. Відкрий знову з бота.",
  anonHolderA: "Учасник",
  anonHolderB: "Твоя пара",
};

const de: StoreStrings = {
  title: "Date-Tickets holen 🎟️",
  sub: "Ein Ticket = ein Date. Leg dir welche zu, dann bist du immer bereit.",
  balance: "Dein Guthaben: {n} 🎟️",
  perTicket: "{amount} / Ticket",
  bestValue: "Bester Preis",
  save: "{pct}% sparen",
  buy: "{count} kaufen — {amount}",
  successTitle: "Tickets hinzugefügt 🎟️",
  successSub: "Dein Guthaben beträgt jetzt {n}. Nutze sie für dein nächstes Date.",
  done: "Fertig",
  processing: "Verarbeitung…",
  back: "← Zurück",
  loading: "Dein Guthaben wird geladen…",
  errGeneric: "Etwas ist schiefgelaufen. Öffne dies erneut aus dem Bot.",
  anonHolderA: "Mitglied",
  anonHolderB: "Dein Date",
};

const pl: StoreStrings = {
  title: "Zdobądź bilety na randki 🎟️",
  sub: "Jeden bilet = jedna randka. Zrób zapas, żeby zawsze być gotowym.",
  balance: "Twój portfel: {n} 🎟️",
  perTicket: "{amount} / bilet",
  bestValue: "Najlepsza cena",
  save: "Oszczędź {pct}%",
  buy: "Kup {count} — {amount}",
  successTitle: "Bilety dodane 🎟️",
  successSub: "W portfelu masz teraz {n}. Użyj ich, gdy ustalisz randkę.",
  done: "Gotowe",
  processing: "Przetwarzanie…",
  back: "← Wstecz",
  loading: "Ładujemy Twój portfel…",
  errGeneric: "Coś poszło nie tak. Otwórz to ponownie z bota.",
  anonHolderA: "Członek",
  anonHolderB: "Twoja randka",
};

const dict: Record<Lang, StoreStrings> = { en, ru, uk, de, pl };

export function pickLang(raw: string | null | undefined): Lang {
  if (raw === "ru" || raw === "uk" || raw === "de" || raw === "pl") return raw;
  return "en";
}

export function strings(lang: Lang): StoreStrings {
  return dict[lang] ?? en;
}

/** Interpolate `{key}` placeholders. */
export function fill(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, v);
  return out;
}
