/**
 * Self-contained i18n for the Date Ticket Mini App. Kept local (not threaded
 * through the calendar's `Strings` table) so the ticket bundle stays
 * independent. Active language comes from `?lang=` on the URL the bot builds.
 */

export type Lang = "en" | "ru" | "uk" | "de" | "pl";

export interface TicketStrings {
  heading: string;
  sub: string;
  ticketLabel: string;
  ticketTagline: string;
  ticketHolders: string;
  payBoth: string;
  paySelf: string;
  paySelfOnly: string;
  mockBadge: string;
  mockTitle: string;
  mockSub: string;
  mockCardLabel: string;
  mockExpLabel: string;
  mockCvcLabel: string;
  mockPayNow: string;
  processing: string;
  successTitle: string;
  successSub: string;
  goToScheduling: string;
  waitingTitle: string;
  waitingSub: string;
  waitingTimer: string;
  partnerPaidTitle: string;
  partnerPaidSub: string;
  closedTitle: string;
  closedSub: string;
  errGeneric: string;
  loading: string;
  back: string;
  close: string;
}

const en: TicketStrings = {
  heading: "It's a match 🔥",
  sub: "Claim your Date Ticket to unlock planning.",
  ticketLabel: "CURATED DATE TICKET",
  ticketTagline: "One Perfect Match • Verified • Zero Drama",
  ticketHolders: "Admit two",
  payBoth: "Pay for us both — {amount}",
  paySelf: "Pay only mine — {amount}",
  paySelfOnly: "Pay my ticket — {amount}",
  mockBadge: "Test mode — no real charge",
  mockTitle: "Payment",
  mockSub: "Pay {amount} to secure your Date Ticket.",
  mockCardLabel: "Card number",
  mockExpLabel: "MM / YY",
  mockCvcLabel: "CVC",
  mockPayNow: "Complete payment · {amount}",
  processing: "Processing…",
  successTitle: "You're in 🎟️",
  successSub: "Both tickets are secured. Time to pick your moment.",
  goToScheduling: "Go to date planning",
  waitingTitle: "Ticket secured 🎟️",
  waitingSub: "Waiting on your match to grab theirs. We'll ping you the second they do.",
  waitingTimer: "They have {time} left",
  partnerPaidTitle: "{name} already paid your ticket ❤️",
  partnerPaidSub: "You're all set — nothing to pay. Let's plan the date.",
  closedTitle: "Scheduling's open 📅",
  closedSub: "No payment needed — let's just find a time.",
  errGeneric: "Something went wrong. Reopen this from the bot.",
  loading: "Loading your ticket…",
  back: "← Back",
  close: "Close",
};

const ru: TicketStrings = {
  heading: "Это метч 🔥",
  sub: "Забери свой билет на свидание, чтобы открыть планирование.",
  ticketLabel: "КУРАТОРСКИЙ БИЛЕТ НА СВИДАНИЕ",
  ticketTagline: "Идеальный метч • Проверено • Без драмы",
  ticketHolders: "На двоих",
  payBoth: "Оплатить за нас обоих — {amount}",
  paySelf: "Оплатить только свой — {amount}",
  paySelfOnly: "Оплатить свой билет — {amount}",
  mockBadge: "Тестовый режим — без реальной оплаты",
  mockTitle: "Оплата",
  mockSub: "Оплати {amount}, чтобы закрепить свой билет.",
  mockCardLabel: "Номер карты",
  mockExpLabel: "ММ / ГГ",
  mockCvcLabel: "CVC",
  mockPayNow: "Завершить оплату · {amount}",
  processing: "Обработка…",
  successTitle: "Готово 🎟️",
  successSub: "Оба билета у вас. Время выбрать момент.",
  goToScheduling: "Перейти к планированию даты",
  waitingTitle: "Билет закреплён 🎟️",
  waitingSub: "Ждём, пока собеседник возьмёт свой. Напишем сразу, как это случится.",
  waitingTimer: "У него осталось {time}",
  partnerPaidTitle: "{name} уже оплатил твой билет ❤️",
  partnerPaidSub: "Тебе ничего не нужно делать. Давай спланируем свидание.",
  closedTitle: "Планирование открыто 📅",
  closedSub: "Оплата не нужна — просто найдём время.",
  errGeneric: "Что-то пошло не так. Открой заново из бота.",
  loading: "Загружаем твой билет…",
  back: "← Назад",
  close: "Закрыть",
};

const uk: TicketStrings = {
  heading: "Це метч 🔥",
  sub: "Забери свій квиток на побачення, щоб відкрити планування.",
  ticketLabel: "КУРАТОРСЬКИЙ КВИТОК НА ПОБАЧЕННЯ",
  ticketTagline: "Ідеальний метч • Перевірено • Без драми",
  ticketHolders: "На двох",
  payBoth: "Сплатити за нас обох — {amount}",
  paySelf: "Сплатити лише свій — {amount}",
  paySelfOnly: "Сплатити свій квиток — {amount}",
  mockBadge: "Тестовий режим — без реальної оплати",
  mockTitle: "Оплата",
  mockSub: "Сплати {amount}, щоб закріпити свій квиток.",
  mockCardLabel: "Номер картки",
  mockExpLabel: "ММ / РР",
  mockCvcLabel: "CVC",
  mockPayNow: "Завершити оплату · {amount}",
  processing: "Обробка…",
  successTitle: "Готово 🎟️",
  successSub: "Обидва квитки у вас. Час обрати момент.",
  goToScheduling: "Перейти до планування побачення",
  waitingTitle: "Квиток закріплено 🎟️",
  waitingSub: "Чекаємо, поки співрозмовник візьме свій. Напишемо щойно це станеться.",
  waitingTimer: "У нього лишилося {time}",
  partnerPaidTitle: "{name} вже сплатив твій квиток ❤️",
  partnerPaidSub: "Тобі нічого не потрібно робити. Сплануймо побачення.",
  closedTitle: "Планування відкрито 📅",
  closedSub: "Оплата не потрібна — просто знайдемо час.",
  errGeneric: "Щось пішло не так. Відкрий знову з бота.",
  loading: "Завантажуємо твій квиток…",
  back: "← Назад",
  close: "Закрити",
};

const dict: Partial<Record<Lang, TicketStrings>> = { en, ru, uk };

export function pickLang(raw: string | null | undefined): Lang {
  if (raw === "ru" || raw === "uk" || raw === "de" || raw === "pl") return raw;
  return "en";
}

export function strings(lang: Lang): TicketStrings {
  return dict[lang] ?? en;
}

/** Interpolate `{key}` placeholders. */
export function fill(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, v);
  return out;
}
