/**
 * Self-contained i18n for the ticket store / wallet Mini App. The hero
 * Ticket3D card reuses the Date Ticket strings (../ticket/i18n) so its labels
 * stay consistent; everything store-specific lives here. The store's card
 * carries no names — it is the product, not anyone's ticket.
 *
 * The headings carry no 🎟️. A rendered ticket is the largest thing on this
 * screen, so an emoji of one above it restates the picture in a platform font
 * we do not control — the same reason `marks.tsx` bans emoji on the card
 * itself. It also competed with the heading at roughly equal optical weight,
 * which is half of why the heading read as light.
 */

export type Lang = "en" | "ru" | "uk" | "de" | "pl";

export interface StoreStrings {
  title: string;
  sub: string;
  /**
   * Why someone whose own dates Premium still covers would buy a ticket
   * (§3.5b). Since 2026-10-08 that is only the grandfathered cover — a period
   * paid before Premium stopped covering tickets — so the line says "this
   * Premium period" and never promises the cover beyond it. Deliberately not
   * "you have Premium" — that they know. What they cannot know is that the
   * store still has a purpose: their own dates are covered for now, and a
   * ticket is what it takes to cover their date's.
   */
  premiumNote: string;
  perTicket: string;
  bestValue: string;
  /** Per-ticket saving badge on multi-ticket bundles. `{pct}` = whole percent. */
  save: string;
  /** Loyalty "famine" discount badge on the single ticket. `{pct}` = percent. */
  famineSave: string;
  buy: string;
  successTitle: string;
  successSub: string;
  done: string;
  back: string;
  loading: string;
  errGeneric: string;
}

const en: StoreStrings = {
  title: "Get Date Tickets",
  sub: "One ticket — one date.",
  premiumNote: "Your current Premium period still covers your own dates. Tickets are for treating your match.",
  perTicket: "{amount} / ticket",
  bestValue: "Best value",
  save: "Save {pct}%",
  famineSave: "−{pct}% for you",
  buy: "Buy {count} — {amount}",
  successTitle: "Tickets added",
  successSub: "In your wallet: {n}.",
  done: "Done",
  back: "← Back",
  loading: "Loading your wallet…",
  errGeneric: "Something went wrong. Reopen this from the bot.",
};

const ru: StoreStrings = {
  title: "Билеты на свидания",
  sub: "Один билет — одно свидание.",
  premiumNote: "В этом периоде Premium твои свидания ещё оплачены. Билеты — чтобы угостить пару.",
  perTicket: "{amount} / билет",
  bestValue: "Выгоднее всего",
  save: "Скидка {pct}%",
  famineSave: "−{pct}% для тебя",
  buy: "Купить {count} — {amount}",
  successTitle: "Билеты добавлены",
  successSub: "В кошельке: {n}.",
  done: "Готово",
  back: "← Назад",
  loading: "Загружаем кошелёк…",
  errGeneric: "Что-то пошло не так. Открой заново из бота.",
};

const uk: StoreStrings = {
  title: "Квитки на побачення",
  sub: "Один квиток — одне побачення.",
  premiumNote: "У цьому періоді Premium твої побачення ще оплачено. Квитки — щоб пригостити пару.",
  perTicket: "{amount} / квиток",
  bestValue: "Найвигідніше",
  save: "Знижка {pct}%",
  famineSave: "−{pct}% для тебе",
  buy: "Купити {count} — {amount}",
  successTitle: "Квитки додано",
  successSub: "У гаманці: {n}.",
  done: "Готово",
  back: "← Назад",
  loading: "Завантажуємо гаманець…",
  errGeneric: "Щось пішло не так. Відкрий знову з бота.",
};

const de: StoreStrings = {
  title: "Date-Tickets holen",
  sub: "Ein Ticket — ein Date.",
  premiumNote: "In deinem laufenden Premium-Zeitraum sind deine Dates noch bezahlt. Tickets sind dafür, dein Match einzuladen.",
  perTicket: "{amount} / Ticket",
  bestValue: "Bester Preis",
  save: "{pct}% sparen",
  famineSave: "−{pct}% für dich",
  buy: "{count} kaufen — {amount}",
  successTitle: "Tickets hinzugefügt",
  successSub: "Im Guthaben: {n}.",
  done: "Fertig",
  back: "← Zurück",
  loading: "Dein Guthaben wird geladen…",
  errGeneric: "Etwas ist schiefgelaufen. Öffne dies erneut aus dem Bot.",
};

const pl: StoreStrings = {
  title: "Zdobądź bilety na randki",
  sub: "Jeden bilet — jedna randka.",
  premiumNote: "W tym okresie Premium twoje randki są jeszcze opłacone. Bilety — żeby zaprosić swoją parę.",
  perTicket: "{amount} / bilet",
  bestValue: "Najlepsza cena",
  save: "Oszczędź {pct}%",
  famineSave: "−{pct}% dla Ciebie",
  buy: "Kup {count} — {amount}",
  successTitle: "Bilety dodane",
  successSub: "W portfelu: {n}.",
  done: "Gotowe",
  back: "← Wstecz",
  loading: "Ładujemy Twój portfel…",
  errGeneric: "Coś poszło nie tak. Otwórz to ponownie z bota.",
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
