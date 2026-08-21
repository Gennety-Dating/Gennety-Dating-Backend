/**
 * Self-contained i18n for the Date Ticket Mini App. Kept local (not threaded
 * through the calendar's `Strings` table) so the ticket bundle stays
 * independent. Active language comes from `?lang=` on the URL the bot builds.
 */

export type Lang = "en" | "ru" | "uk" | "de" | "pl";

export interface TicketStrings {
  /**
   * TRANSLATOR NOTE — no 🎟️ in any screen HEADING. Every screen renders the
   * ticket itself, at 268×392, directly under the heading: an emoji of one
   * above it restates the picture in a platform font we do not control (the
   * rule `marks.tsx` applies to the card) while competing with the heading at
   * roughly equal optical weight. The store's headings were cleared for the
   * same reason on 2026-08-08; the gate's are cleared here.
   *
   * BUTTON labels keep theirs: 🎟️ there distinguishes the two payment rails
   * ("use a wallet ticket" vs "pay money"), which is a job, not decoration.
   *
   * No 🤍 either (founder decision 2026-08-19). It used to close this one line
   * on the grounds that the heart IS the match rather than a restatement of
   * the picture below — but it sits on the screen that asks for money, where a
   * decorative glyph beside the headline is the one thing that reads as
   * marketing rather than as a receipt. The mutual-match warmth is carried by
   * the chat card's falling-hearts message effect, which is the moment for it.
   */
  heading: string;
  sub: string;
  payBoth: string;
  payBothWithTicket: string;
  paySelf: string;
  paySelfOnly: string;
  /** Famine single-ticket discount badge on the self-pay button. `{pct}`. */
  famineBadge: string;
  useSelf: string;
  useBoth: string;
  usePartner: string;
  payPartner: string;
  coverPartnerTitle: string;
  coverPartnerSub: string;
  /**
   * Why this user's own slot is already settled when they never paid for it
   * (§3.5b — Premium covers a subscriber's own ticket). Without it a covered
   * woman opens the card, reads "waiting on them", and is given no account at
   * all of why hers is done.
   */
  premiumCovered: string;
  /**
   * Shown to a covered MALE on the cover screen. Premium closes his slot and
   * deliberately not hers, so the one thing he could still misread — that
   * covering her is included too — is stated where he is about to decide.
   */
  premiumCoverNotIncluded: string;
  justWait: string;
  /**
   * The way back from the waiting screen after he declined the cover offer.
   *
   * It is the only thing on that screen that DOES anything — "Close" merely
   * repeats Telegram's own ✕ in the chrome above — so it takes the button slot
   * and Close drops to the text rung beneath it. It shipped the other way round
   * (a 14px grey link under a full-width Close), which is the same inversion
   * §3.5b already corrected once on the cover screen itself.
   */
  coverReconsider: string;
  /**
   * The field name printed on the ticket stub, left of the count. One word,
   * rendered uppercase by CSS — it is what turns the number on the right from a
   * decoration into a value the user can read.
   */
  balanceLabel: string;
  balanceNote: string;
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
  /**
   * Success screen when HE covered HER ticket — the goodwill gesture (§3.5b).
   *
   * TRANSLATOR NOTE: `coveredHerTitle` is a mate clapping you on the shoulder —
   * "respect", "well played". It is NOT a compliment about his looks, which is
   * exactly why «Красавчик!» / «Красунчик!» were dropped: they read as "handsome
   * guy" to half the audience. Prefer the plain, unambiguous "respect" in every
   * locale. Keep the register warm and peer-level — never congratulatory-from-
   * above, never sentimental, and no emoji.
   */
  coveredHerTitle: string;
  coveredHerSub: string;
  goToScheduling: string;
  waitingTitle: string;
  waitingSub: string;
  /**
   * The partner's remaining window, rendered under `waitingSub`. `{time}`.
   *
   * TRANSLATOR NOTE: it MUST name whose window it is. The English line always
   * did ("They have {time} left"); the four translations had been reduced to a
   * bare "Осталось {time}" while making them gender-neutral, which left a
   * number on screen that said neither what was running out nor for whom. Name
   * the person with the same role noun `waitingSub` uses, in a form that works
   * for a partner of either gender.
   */
  waitingTimer: string;
  /** Countdown units for `waitingTimer`'s `{time}` — each carries `{n}`. */
  timeHours: string;
  timeMinutes: string;
  /** Under a minute; a phrase, so no `{n}`. */
  timeSoon: string;
  partnerPaidTitle: string;
  partnerPaidSub: string;
  /** Tiny "PAID" seal on the covered-ticket hero (partner-paid screen). */
  partnerPaidStamp: string;
  closedTitle: string;
  closedSub: string;
  errGeneric: string;
  loading: string;
  back: string;
  close: string;
  youFallback: string;
  matchFallback: string;
}

const en: TicketStrings = {
  heading: "It's a match",
  sub: "Claim your Date Ticket to unlock planning.",
  payBoth: "Pay for us both — {amount}",
  payBothWithTicket: "Pay for both 🎟️ + {amount}",
  paySelf: "Pay only mine — {amount}",
  paySelfOnly: "Pay my ticket — {amount}",
  famineBadge: "−{pct}% for you",
  useSelf: "Use a ticket — for you 🎟️",
  useBoth: "Use 2 tickets — you & your date 🎟️🎟️",
  usePartner: "Use a ticket for your date 🎟️",
  payPartner: "Pay for your date — {amount}",
  coverPartnerTitle: "Cover your date?",
  coverPartnerSub: "Your ticket's set. Want to cover {name}'s too, or let them grab it?",
  premiumCovered: "Premium covers your ticket ✨",
  premiumCoverNotIncluded: "Premium covers yours only — {name}'s is one ticket's price.",
  justWait: "I'll let them grab it",
  coverReconsider: "Actually — cover their ticket",
  balanceLabel: "Balance",
  balanceNote: "Your wallet: {n}",
  mockBadge: "Test mode — no real charge",
  mockTitle: "Payment",
  mockSub: "Pay {amount} to secure your Date Ticket.",
  mockCardLabel: "Card number",
  mockExpLabel: "MM / YY",
  mockCvcLabel: "CVC",
  mockPayNow: "Complete payment · {amount}",
  processing: "Processing…",
  successTitle: "You're in",
  successSub: "Both tickets are secured. Time to pick your moment.",
  coveredHerTitle: "Nice one!",
  coveredHerSub: "You covered {name}'s ticket — we've let her know. Now just pick your moment.",
  goToScheduling: "Go to date planning",
  waitingTitle: "Ticket secured",
  waitingSub: "Waiting on your match to grab theirs. We'll ping you the second they do.",
  waitingTimer: "They have {time} left",
  timeHours: "{n}h",
  timeMinutes: "{n}m",
  timeSoon: "under a minute",
  partnerPaidTitle: "{name} already paid your ticket",
  partnerPaidSub: "Nothing to pay — it's already covered.",
  partnerPaidStamp: "Paid",
  closedTitle: "Scheduling's open 📅",
  closedSub: "No payment needed — let's just find a time.",
  errGeneric: "Something went wrong. Reopen this from the bot.",
  loading: "Loading your ticket…",
  back: "← Back",
  close: "Close",
  youFallback: "You",
  matchFallback: "Your match",
};

const ru: TicketStrings = {
  heading: "Это мэтч",
  sub: "Забери свой билет на свидание, чтобы открыть планирование.",
  payBoth: "Оплатить за нас обоих — {amount}",
  payBothWithTicket: "Оплатить за двоих 🎟️ + {amount}",
  paySelf: "Оплатить только свой — {amount}",
  paySelfOnly: "Оплатить свой билет — {amount}",
  famineBadge: "−{pct}% для тебя",
  useSelf: "Использовать билет — за себя 🎟️",
  useBoth: "Использовать 2 билета — ты и пара 🎟️🎟️",
  usePartner: "Использовать билет за пару 🎟️",
  payPartner: "Оплатить за пару — {amount}",
  coverPartnerTitle: "Оплатить за пару?",
  coverPartnerSub: "Твой билет уже есть. Оплатить и за {name} или пусть берёт сам(а)?",
  premiumCovered: "Твой билет покрыт Premium ✨",
  premiumCoverNotIncluded: "Premium покрывает только твой — билет {name} стоит одну цену.",
  justWait: "Пусть берёт сам(а)",
  coverReconsider: "Всё-таки оплатить за пару",
  balanceLabel: "Баланс",
  balanceNote: "Твой кошелёк: {n}",
  mockBadge: "Тестовый режим — без реальной оплаты",
  mockTitle: "Оплата",
  mockSub: "Оплати {amount}, чтобы закрепить свой билет.",
  mockCardLabel: "Номер карты",
  mockExpLabel: "ММ / ГГ",
  mockCvcLabel: "CVC",
  mockPayNow: "Завершить оплату · {amount}",
  processing: "Обработка…",
  successTitle: "Готово",
  successSub: "Оба билета у вас. Время выбрать момент.",
  coveredHerTitle: "Респект!",
  coveredHerSub: "Ты оплатил билет за {name} — мы дали ей знать. Осталось выбрать момент.",
  goToScheduling: "Перейти к планированию даты",
  waitingTitle: "Билет закреплён",
  waitingSub: "Ждём, пока собеседник возьмёт свой. Напишем сразу, как это случится.",
  // Names the subject without gendering it: the male reaches this screen too
  // (he can decline the cover offer), so «У неё» would be wrong for half the
  // viewers — but «Осталось» alone named nobody at all.
  waitingTimer: "У собеседника осталось {time}",
  timeHours: "{n} ч",
  timeMinutes: "{n} мин",
  timeSoon: "меньше минуты",
  partnerPaidTitle: "{name} уже оплатил твой билет",
  partnerPaidSub: "Платить не нужно — всё уже оплачено.",
  partnerPaidStamp: "Оплачено",
  closedTitle: "Планирование открыто 📅",
  closedSub: "Оплата не нужна — просто найдём время.",
  errGeneric: "Что-то пошло не так. Открой заново из бота.",
  loading: "Загружаем твой билет…",
  back: "← Назад",
  close: "Закрыть",
  youFallback: "Ты",
  matchFallback: "Твой мэтч",
};

const uk: TicketStrings = {
  heading: "Це метч",
  sub: "Забери свій квиток на побачення, щоб відкрити планування.",
  payBoth: "Сплатити за нас обох — {amount}",
  payBothWithTicket: "Сплатити за двох 🎟️ + {amount}",
  paySelf: "Сплатити лише свій — {amount}",
  paySelfOnly: "Сплатити свій квиток — {amount}",
  famineBadge: "−{pct}% для тебе",
  useSelf: "Використати квиток — за себе 🎟️",
  useBoth: "Використати 2 квитки — ти і пара 🎟️🎟️",
  usePartner: "Використати квиток за пару 🎟️",
  payPartner: "Сплатити за пару — {amount}",
  coverPartnerTitle: "Сплатити за пару?",
  coverPartnerSub: "Твій квиток уже є. Сплатити й за {name} чи нехай бере сам(а)?",
  premiumCovered: "Твій квиток покритий Premium ✨",
  premiumCoverNotIncluded: "Premium покриває лише твій — квиток {name} коштує одну ціну.",
  justWait: "Нехай бере сам(а)",
  coverReconsider: "Все-таки сплатити за пару",
  balanceLabel: "Баланс",
  balanceNote: "Твій гаманець: {n}",
  mockBadge: "Тестовий режим — без реальної оплати",
  mockTitle: "Оплата",
  mockSub: "Сплати {amount}, щоб закріпити свій квиток.",
  mockCardLabel: "Номер картки",
  mockExpLabel: "ММ / РР",
  mockCvcLabel: "CVC",
  mockPayNow: "Завершити оплату · {amount}",
  processing: "Обробка…",
  successTitle: "Готово",
  successSub: "Обидва квитки у вас. Час обрати момент.",
  coveredHerTitle: "Респект!",
  coveredHerSub: "Ти оплатив квиток за {name} — ми дали їй знати. Лишилось обрати момент.",
  goToScheduling: "Перейти до планування побачення",
  waitingTitle: "Квиток закріплено",
  waitingSub: "Чекаємо, поки співрозмовник візьме свій. Напишемо щойно це станеться.",
  waitingTimer: "У співрозмовника залишилось {time}",
  timeHours: "{n} год",
  timeMinutes: "{n} хв",
  timeSoon: "менше хвилини",
  partnerPaidTitle: "{name} вже сплатив твій квиток",
  partnerPaidSub: "Платити не потрібно — усе вже сплачено.",
  partnerPaidStamp: "Сплачено",
  closedTitle: "Планування відкрито 📅",
  closedSub: "Оплата не потрібна — просто знайдемо час.",
  errGeneric: "Щось пішло не так. Відкрий знову з бота.",
  loading: "Завантажуємо твій квиток…",
  back: "← Назад",
  close: "Закрити",
  youFallback: "Ти",
  matchFallback: "Твій метч",
};

const de: TicketStrings = {
  heading: "Es ist ein Match",
  sub: "Sichere dein Date Ticket, um die Planung freizuschalten.",
  payBoth: "Für uns beide zahlen — {amount}",
  payBothWithTicket: "Für beide zahlen 🎟️ + {amount}",
  paySelf: "Nur meins zahlen — {amount}",
  paySelfOnly: "Mein Ticket zahlen — {amount}",
  famineBadge: "−{pct}% für dich",
  useSelf: "Ticket nutzen — für dich 🎟️",
  useBoth: "2 Tickets nutzen — du & dein Date 🎟️🎟️",
  usePartner: "Ticket für dein Date nutzen 🎟️",
  payPartner: "Für dein Date zahlen — {amount}",
  coverPartnerTitle: "Date übernehmen?",
  coverPartnerSub: "Dein Ticket steht. Auch {name} übernehmen oder selbst holen lassen?",
  premiumCovered: "Premium deckt dein Ticket ✨",
  premiumCoverNotIncluded: "Premium deckt nur deins — das von {name} kostet einen Ticketpreis.",
  justWait: "Sollen sie selbst holen",
  coverReconsider: "Doch für dein Date zahlen",
  balanceLabel: "Guthaben",
  balanceNote: "Dein Guthaben: {n}",
  mockBadge: "Testmodus — keine echte Abbuchung",
  mockTitle: "Zahlung",
  mockSub: "Zahle {amount}, um dein Date Ticket zu sichern.",
  mockCardLabel: "Kartennummer",
  mockExpLabel: "MM / JJ",
  mockCvcLabel: "CVC",
  mockPayNow: "Zahlung abschließen · {amount}",
  processing: "Verarbeitung...",
  successTitle: "Du bist dabei",
  successSub: "Beide Tickets sind gesichert. Jetzt wählt ihr euren Moment.",
  coveredHerTitle: "Respekt!",
  coveredHerSub: "Du hast {name}s Ticket übernommen — sie weiß Bescheid. Jetzt nur noch euren Moment wählen.",
  goToScheduling: "Date planen",
  waitingTitle: "Ticket gesichert",
  waitingSub: "Wir warten, bis dein Match das eigene Ticket sichert. Dann melden wir uns sofort.",
  waitingTimer: "Dein Match hat noch {time}",
  timeHours: "{n} Std.",
  timeMinutes: "{n} Min.",
  timeSoon: "weniger als eine Minute",
  partnerPaidTitle: "{name} hat dein Ticket schon bezahlt",
  partnerPaidSub: "Nichts zu zahlen — schon erledigt.",
  partnerPaidStamp: "Bezahlt",
  closedTitle: "Planung ist offen 📅",
  closedSub: "Keine Zahlung nötig — findet einfach eine Zeit.",
  errGeneric: "Etwas ist schiefgelaufen. Öffne dies erneut aus dem Bot.",
  loading: "Dein Ticket wird geladen...",
  back: "← Zurück",
  close: "Schließen",
  youFallback: "Du",
  matchFallback: "Dein Match",
};

const pl: TicketStrings = {
  heading: "To match",
  sub: "Odbierz Date Ticket, aby odblokować planowanie.",
  payBoth: "Zapłać za nas oboje — {amount}",
  payBothWithTicket: "Zapłać za oboje 🎟️ + {amount}",
  paySelf: "Zapłać tylko za siebie — {amount}",
  paySelfOnly: "Zapłać za swój bilet — {amount}",
  famineBadge: "−{pct}% dla Ciebie",
  useSelf: "Użyj biletu — za siebie 🎟️",
  useBoth: "Użyj 2 biletów — Ty i Twoja randka 🎟️🎟️",
  usePartner: "Użyj biletu za swoją randkę 🎟️",
  payPartner: "Zapłać za swoją randkę — {amount}",
  coverPartnerTitle: "Pokryć randkę?",
  coverPartnerSub: "Twój bilet jest. Pokryć też {name} czy niech weźmie sam(a)?",
  premiumCovered: "Premium pokrywa twój bilet ✨",
  premiumCoverNotIncluded: "Premium pokrywa tylko twój — bilet {name} kosztuje jedną cenę.",
  justWait: "Niech weźmie sam(a)",
  coverReconsider: "Jednak zapłać za swoją randkę",
  balanceLabel: "Saldo",
  balanceNote: "Twój portfel: {n}",
  mockBadge: "Tryb testowy — bez prawdziwej opłaty",
  mockTitle: "Płatność",
  mockSub: "Zapłać {amount}, aby zabezpieczyć Date Ticket.",
  mockCardLabel: "Numer karty",
  mockExpLabel: "MM / RR",
  mockCvcLabel: "CVC",
  mockPayNow: "Dokończ płatność · {amount}",
  processing: "Przetwarzanie...",
  successTitle: "Gotowe",
  successSub: "Oba bilety są zabezpieczone. Czas wybrać termin.",
  coveredHerTitle: "Respekt!",
  coveredHerSub: "Opłaciłeś bilet za {name} — daliśmy jej znać. Teraz wybierz termin.",
  goToScheduling: "Przejdź do planowania randki",
  waitingTitle: "Bilet zabezpieczony",
  waitingSub: "Czekamy, aż Twoje dopasowanie odbierze swój. Od razu damy Ci znać.",
  waitingTimer: "Twoje dopasowanie ma jeszcze {time}",
  timeHours: "{n} godz.",
  timeMinutes: "{n} min",
  timeSoon: "mniej niż minuta",
  partnerPaidTitle: "{name} zapłacił już za Twój bilet",
  partnerPaidSub: "Nic nie płacisz — już opłacone.",
  partnerPaidStamp: "Opłacone",
  closedTitle: "Planowanie jest otwarte 📅",
  closedSub: "Płatność nie jest potrzebna — znajdźmy termin.",
  errGeneric: "Coś poszło nie tak. Otwórz to ponownie z bota.",
  loading: "Ładujemy Twój bilet...",
  back: "← Wstecz",
  close: "Zamknij",
  youFallback: "Ty",
  matchFallback: "Twoje dopasowanie",
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
