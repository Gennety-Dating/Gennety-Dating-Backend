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
  /**
   * The counterfactual at the pay step: this date would have cost nothing on a
   * subscription. Says "YOUR ticket", never a bare "free" — Premium covers the
   * subscriber's own slot and deliberately not their date's, so the venue
   * board's own wording ("Free with Gennety Premium", where the whole fee does
   * vanish) would over-promise here.
   */
  premiumWouldCover: string;
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
  sub: "Grab your ticket and we'll pick a time.",
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
  coverPartnerSub: "Get a ticket for {name} too?",
  premiumCovered: "Premium covers your ticket ✨",
  premiumCoverNotIncluded: "Premium covers only you. {name}'s ticket is separate.",
  premiumWouldCover: "Your ticket is free with Premium",
  justWait: "I'll let them grab it",
  coverReconsider: "Actually — cover their ticket",
  balanceLabel: "Balance",
  balanceNote: "Your wallet: {n}",
  successTitle: "You're in",
  successSub: "You both have tickets. Now pick a time.",
  coveredHerTitle: "Lovely!",
  coveredHerSub: "{name} already knows. Now just pick a time.",
  goToScheduling: "Pick a time",
  waitingTitle: "The ticket's yours",
  waitingSub: "Waiting for your match — we'll message you as soon as they grab theirs.",
  waitingTimer: "They have {time} left",
  timeHours: "{n}h",
  timeMinutes: "{n}m",
  timeSoon: "under a minute",
  partnerPaidTitle: "{name} already paid your ticket",
  partnerPaidStamp: "Paid",
  closedTitle: "Picking a time 📅",
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
  sub: "Возьми билет — и выберем время.",
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
  coverPartnerSub: "Возьмёшь билет и для {name}?",
  premiumCovered: "Твой билет покрыт Premium ✨",
  premiumCoverNotIncluded: "Premium — только за тебя. Билет для {name} — отдельно.",
  premiumWouldCover: "С Premium твой билет бесплатный",
  justWait: "Пусть возьмёт свой",
  coverReconsider: "Всё-таки оплатить за пару",
  balanceLabel: "Баланс",
  balanceNote: "Твой кошелёк: {n}",
  successTitle: "Готово",
  successSub: "Билеты у обоих. Теперь выберите время.",
  coveredHerTitle: "Красиво!",
  coveredHerSub: "{name} уже знает. Осталось выбрать время.",
  goToScheduling: "Выбрать время",
  waitingTitle: "Билет твой",
  waitingSub: "Ждём твою пару — напишем, как только возьмёт свой.",
  // Names the subject without gendering it: the male reaches this screen too
  // (he can decline the cover offer), so «У неё» would be wrong for half the
  // viewers — but «Осталось» alone named nobody at all.
  waitingTimer: "У твоей пары осталось {time}",
  timeHours: "{n} ч",
  timeMinutes: "{n} мин",
  timeSoon: "меньше минуты",
  partnerPaidTitle: "{name} уже оплатил твой билет",
  partnerPaidStamp: "Оплачено",
  closedTitle: "Выбираем время 📅",
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
  sub: "Візьми квиток — і оберемо час.",
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
  coverPartnerSub: "Візьмеш квиток і для {name}?",
  premiumCovered: "Твій квиток покритий Premium ✨",
  premiumCoverNotIncluded: "Premium — лише за тебе. Квиток для {name} — окремо.",
  premiumWouldCover: "З Premium твій квиток безкоштовний",
  justWait: "Нехай візьме свій",
  coverReconsider: "Все-таки сплатити за пару",
  balanceLabel: "Баланс",
  balanceNote: "Твій гаманець: {n}",
  successTitle: "Готово",
  successSub: "Квитки в обох. Тепер оберіть час.",
  coveredHerTitle: "Красиво!",
  coveredHerSub: "{name} вже знає. Лишилось обрати час.",
  goToScheduling: "Обрати час",
  waitingTitle: "Квиток твій",
  waitingSub: "Чекаємо на твою пару — напишемо, щойно візьме свій.",
  waitingTimer: "У твоєї пари залишилось {time}",
  timeHours: "{n} год",
  timeMinutes: "{n} хв",
  timeSoon: "менше хвилини",
  partnerPaidTitle: "{name} вже сплатив твій квиток",
  partnerPaidStamp: "Сплачено",
  closedTitle: "Обираємо час 📅",
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
  sub: "Hol dir dein Ticket — dann wählen wir die Zeit.",
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
  coverPartnerSub: "Holst du auch ein Ticket für {name}?",
  premiumCovered: "Premium deckt dein Ticket ✨",
  premiumCoverNotIncluded: "Premium gilt nur für dich. Das Ticket für {name} kommt extra.",
  premiumWouldCover: "Mit Premium ist dein Ticket frei",
  justWait: "Sollen sie selbst holen",
  coverReconsider: "Doch für dein Date zahlen",
  balanceLabel: "Guthaben",
  balanceNote: "Dein Guthaben: {n}",
  successTitle: "Du bist dabei",
  successSub: "Ihr habt beide Tickets. Jetzt wählt eine Zeit.",
  coveredHerTitle: "Stark!",
  coveredHerSub: "{name} weiß schon Bescheid. Jetzt nur noch die Zeit wählen.",
  goToScheduling: "Zeit wählen",
  waitingTitle: "Das Ticket ist deins",
  waitingSub: "Wir warten auf dein Match — wir schreiben dir, sobald das zweite Ticket da ist.",
  waitingTimer: "Dein Match hat noch {time}",
  timeHours: "{n} Std.",
  timeMinutes: "{n} Min.",
  timeSoon: "weniger als eine Minute",
  partnerPaidTitle: "{name} hat dein Ticket schon bezahlt",
  partnerPaidStamp: "Bezahlt",
  closedTitle: "Wir wählen die Zeit 📅",
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
  sub: "Weź bilet — i wybierzemy termin.",
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
  coverPartnerSub: "Weźmiesz bilet też dla {name}?",
  premiumCovered: "Premium pokrywa twój bilet ✨",
  premiumCoverNotIncluded: "Premium — tylko za ciebie. Bilet dla {name} — osobno.",
  premiumWouldCover: "Z Premium twój bilet jest darmowy",
  justWait: "Niech weźmie swój",
  coverReconsider: "Jednak zapłać za swoją randkę",
  balanceLabel: "Saldo",
  balanceNote: "Twój portfel: {n}",
  successTitle: "Gotowe",
  successSub: "Oboje macie bilety. Teraz wybierzcie termin.",
  coveredHerTitle: "Pięknie!",
  coveredHerSub: "{name} już wie. Zostało wybrać termin.",
  goToScheduling: "Wybierz termin",
  waitingTitle: "Bilet jest twój",
  waitingSub: "Czekamy na twoją parę — napiszemy, gdy tylko weźmie swój.",
  waitingTimer: "Twoje dopasowanie ma jeszcze {time}",
  timeHours: "{n} godz.",
  timeMinutes: "{n} min",
  timeSoon: "mniej niż minuta",
  partnerPaidTitle: "{name} zapłacił już za Twój bilet",
  partnerPaidStamp: "Opłacone",
  closedTitle: "Wybieramy termin 📅",
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
