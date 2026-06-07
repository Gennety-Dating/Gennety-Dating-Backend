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
  youFallback: string;
  matchFallback: string;
  ticketStub: string;
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
  youFallback: "You",
  matchFallback: "Your match",
  ticketStub: "ADMIT 2",
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
  youFallback: "Ты",
  matchFallback: "Твой мэтч",
  ticketStub: "НА ДВОИХ",
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
  youFallback: "Ти",
  matchFallback: "Твій метч",
  ticketStub: "НА ДВОХ",
};

const de: TicketStrings = {
  heading: "Es ist ein Match 🔥",
  sub: "Sichere dein Date Ticket, um die Planung freizuschalten.",
  ticketLabel: "KURATIERTES DATE TICKET",
  ticketTagline: "Ein perfektes Match • Verifiziert • Kein Drama",
  ticketHolders: "Für zwei",
  payBoth: "Für uns beide zahlen — {amount}",
  paySelf: "Nur meins zahlen — {amount}",
  paySelfOnly: "Mein Ticket zahlen — {amount}",
  mockBadge: "Testmodus — keine echte Abbuchung",
  mockTitle: "Zahlung",
  mockSub: "Zahle {amount}, um dein Date Ticket zu sichern.",
  mockCardLabel: "Kartennummer",
  mockExpLabel: "MM / JJ",
  mockCvcLabel: "CVC",
  mockPayNow: "Zahlung abschließen · {amount}",
  processing: "Verarbeitung...",
  successTitle: "Du bist dabei 🎟️",
  successSub: "Beide Tickets sind gesichert. Jetzt wählt ihr euren Moment.",
  goToScheduling: "Date planen",
  waitingTitle: "Ticket gesichert 🎟️",
  waitingSub: "Wir warten, bis dein Match das eigene Ticket sichert. Dann melden wir uns sofort.",
  waitingTimer: "Noch {time}",
  partnerPaidTitle: "{name} hat dein Ticket schon bezahlt ❤️",
  partnerPaidSub: "Alles erledigt — du musst nichts zahlen. Plant jetzt euer Date.",
  closedTitle: "Planung ist offen 📅",
  closedSub: "Keine Zahlung nötig — findet einfach eine Zeit.",
  errGeneric: "Etwas ist schiefgelaufen. Öffne dies erneut aus dem Bot.",
  loading: "Dein Ticket wird geladen...",
  back: "← Zurück",
  close: "Schließen",
  youFallback: "Du",
  matchFallback: "Dein Match",
  ticketStub: "FÜR 2",
};

const pl: TicketStrings = {
  heading: "To dopasowanie 🔥",
  sub: "Odbierz Date Ticket, aby odblokować planowanie.",
  ticketLabel: "WYBRANY DATE TICKET",
  ticketTagline: "Jedno idealne dopasowanie • Weryfikacja • Bez dramatu",
  ticketHolders: "Dla dwojga",
  payBoth: "Zapłać za nas oboje — {amount}",
  paySelf: "Zapłać tylko za siebie — {amount}",
  paySelfOnly: "Zapłać za swój bilet — {amount}",
  mockBadge: "Tryb testowy — bez prawdziwej opłaty",
  mockTitle: "Płatność",
  mockSub: "Zapłać {amount}, aby zabezpieczyć Date Ticket.",
  mockCardLabel: "Numer karty",
  mockExpLabel: "MM / RR",
  mockCvcLabel: "CVC",
  mockPayNow: "Dokończ płatność · {amount}",
  processing: "Przetwarzanie...",
  successTitle: "Gotowe 🎟️",
  successSub: "Oba bilety są zabezpieczone. Czas wybrać termin.",
  goToScheduling: "Przejdź do planowania randki",
  waitingTitle: "Bilet zabezpieczony 🎟️",
  waitingSub: "Czekamy, aż Twoje dopasowanie odbierze swój. Od razu damy Ci znać.",
  waitingTimer: "Pozostało {time}",
  partnerPaidTitle: "{name} zapłacił już za Twój bilet ❤️",
  partnerPaidSub: "Wszystko gotowe — nic nie musisz płacić. Zaplanujmy randkę.",
  closedTitle: "Planowanie jest otwarte 📅",
  closedSub: "Płatność nie jest potrzebna — znajdźmy termin.",
  errGeneric: "Coś poszło nie tak. Otwórz to ponownie z bota.",
  loading: "Ładujemy Twój bilet...",
  back: "← Wstecz",
  close: "Zamknij",
  youFallback: "Ty",
  matchFallback: "Twoje dopasowanie",
  ticketStub: "DLA 2",
};

const dict: Record<Lang, TicketStrings> = { en, ru, uk, de, pl };

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
