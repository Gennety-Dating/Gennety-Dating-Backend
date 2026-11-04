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
  /** Famine single-ticket discount badge on the self-pay button. `{pct}`. */
  famineBadge: string;
  useSelf: string;
  useBoth: string;
  coverPartnerTitle: string;
  coverPartnerSub: string;
  /**
   * Why this user's own slot is already settled when they never paid for it.
   * Only the grandfathered Premium ticket cover does that since 2026-10-08
   * (§3.5b — subscribers paid up before Premium stopped covering tickets keep
   * it until that paid period ends), so this line is drawn only from
   * `myPremiumActive`, which the server computes from that cover. Without it a
   * covered woman opens the card, reads "waiting on them", and is given no
   * account at all of why hers is done.
   */
  premiumCovered: string;
  /**
   * Shown to a covered MALE on the cover screen (grandfathered cover only, as
   * above). The cover closes his slot and deliberately not hers, so the one
   * thing he could still misread — that covering her is included too — is
   * stated where he is about to decide.
   *
   * The pay-step counterfactual that used to follow ("Your ticket is free with
   * Premium") was deleted on 2026-10-08 with the benefit it advertised.
   */
  premiumCoverNotIncluded: string;
  /**
   * The field name printed on the ticket stub, left of the count. One word,
   * rendered uppercase by CSS — it is what turns the number on the right from a
   * decoration into a value the user can read.
   */
  balanceLabel: string;
  balanceNote: string;
  successTitle: string;
  goToScheduling: string;
  waitingTitle: string;
  waitingSub: string;
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
  /** Pay button on the gate — `{amount}` is the Stars or dollar price. iOS `ticket.reader.pay`. */
  payAmount: string;
  /** The quiet line under the gate's one action: switch to paying only your own ticket. */
  scopeOnlyMine: string;
  /** The same line, switched back: pay for both tickets. */
  scopeBoth: string;
  /** Accessible caption of the countdown capsule (the capsule itself shows only the clock). */
  deadlineLabel: string;
  coverAction: string;
  coverConfirm: string;
  coverCancel: string;
  coverConfirmHint: string;
  /** Wallet line under the cover panel — plural forms, each carries `{n}`. */
  walletOne: string;
  walletFew: string;
  walletMany: string;
  walletOther: string;
  walletTopUp: string;
  securedMine: string;
}

const en: TicketStrings = {
  heading: "Your date needs a ticket",
  sub: "You both said yes. One Date Ticket per person, then you pick the time together.",
  famineBadge: "−{pct}% for you",
  useSelf: "Use ticket",
  useBoth: "Use 2 tickets",
  coverPartnerTitle: "Pay for the second ticket too?",
  coverPartnerSub: "{name} will find out it's already paid for.",
  premiumCovered: "Premium covers your ticket ✨",
  premiumCoverNotIncluded: "Premium covers only you. {name}'s ticket is separate.",
  balanceLabel: "Balance",
  balanceNote: "Your wallet: {n}",
  successTitle: "Both tickets are in",
  goToScheduling: "Choose a time",
  waitingTitle: "Your ticket is secured",
  waitingSub: "Waiting on the second ticket now.",
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
  payAmount: "Pay {amount}",
  scopeOnlyMine: "Pay only for mine",
  scopeBoth: "Pay for both tickets",
  deadlineLabel: "Time left:",
  coverAction: "I'll cover it",
  coverConfirm: "Confirm",
  coverCancel: "Cancel",
  coverConfirmHint: "Tap Confirm to pay for the second ticket",
  walletOne: "{n} ticket in your wallet",
  walletFew: "{n} tickets in your wallet",
  walletMany: "{n} tickets in your wallet",
  walletOther: "{n} tickets in your wallet",
  walletTopUp: "Buy more",
  securedMine: "Your ticket",
};

const ru: TicketStrings = {
  heading: "Свиданию нужен билет",
  sub: "Вы оба сказали «да». По одному билету с каждого — и переходим ко времени.",
  famineBadge: "−{pct}% для тебя",
  useSelf: "Использовать билет",
  useBoth: "Использовать 2 билета",
  coverPartnerTitle: "Оплатить и второй билет?",
  coverPartnerSub: "{name} узнает, что он уже оплачен.",
  premiumCovered: "Твой билет покрыт Premium ✨",
  premiumCoverNotIncluded: "Premium — только за тебя. Билет для {name} — отдельно.",
  balanceLabel: "Баланс",
  balanceNote: "Твой кошелёк: {n}",
  successTitle: "Оба билета на месте",
  goToScheduling: "Выбрать время",
  waitingTitle: "Твой билет на месте",
  waitingSub: "Ждём второй билет.",
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
  payAmount: "Оплатить · {amount}",
  scopeOnlyMine: "Оплатить только свой",
  scopeBoth: "Оплатить оба билета",
  deadlineLabel: "Осталось:",
  coverAction: "Беру на себя",
  coverConfirm: "Подтвердить",
  coverCancel: "Отмена",
  coverConfirmHint: "Нажми «Подтвердить», чтобы оплатить второй билет",
  walletOne: "{n} билет в кошельке",
  walletFew: "{n} билета в кошельке",
  walletMany: "{n} билетов в кошельке",
  walletOther: "{n} билета в кошельке",
  walletTopUp: "Пополнить",
  securedMine: "Твой билет",
};

const uk: TicketStrings = {
  heading: "Побаченню потрібен квиток",
  sub: "Ви обоє сказали «так». По одному квитку з кожного — і переходимо до часу.",
  famineBadge: "−{pct}% для тебе",
  useSelf: "Використати квиток",
  useBoth: "Використати 2 квитки",
  coverPartnerTitle: "Оплатити і другий квиток?",
  coverPartnerSub: "{name} дізнається, що він уже оплачений.",
  premiumCovered: "Твій квиток покритий Premium ✨",
  premiumCoverNotIncluded: "Premium — лише за тебе. Квиток для {name} — окремо.",
  balanceLabel: "Баланс",
  balanceNote: "Твій гаманець: {n}",
  successTitle: "Обидва квитки на місці",
  goToScheduling: "Обрати час",
  waitingTitle: "Твій квиток на місці",
  waitingSub: "Чекаємо на другий квиток.",
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
  payAmount: "Оплатити · {amount}",
  scopeOnlyMine: "Сплатити лише свій",
  scopeBoth: "Сплатити обидва квитки",
  deadlineLabel: "Залишилося:",
  coverAction: "Беру на себе",
  coverConfirm: "Підтвердити",
  coverCancel: "Скасувати",
  coverConfirmHint: "Натисни «Підтвердити», щоб оплатити другий квиток",
  walletOne: "{n} квиток у гаманці",
  walletFew: "{n} квитки у гаманці",
  walletMany: "{n} квитків у гаманці",
  walletOther: "{n} квитка у гаманці",
  walletTopUp: "Поповнити",
  securedMine: "Твій квиток",
};

const de: TicketStrings = {
  heading: "Euer Date braucht ein Ticket",
  sub: "Ihr habt beide Ja gesagt. Ein Date-Ticket pro Person, dann wählt ihr die Zeit.",
  famineBadge: "−{pct}% für dich",
  useSelf: "Ticket einlösen",
  useBoth: "2 Tickets einlösen",
  coverPartnerTitle: "Auch das zweite Ticket bezahlen?",
  coverPartnerSub: "{name} erfährt, dass es schon bezahlt ist.",
  premiumCovered: "Premium deckt dein Ticket ✨",
  premiumCoverNotIncluded: "Premium gilt nur für dich. Das Ticket für {name} kommt extra.",
  balanceLabel: "Guthaben",
  balanceNote: "Dein Guthaben: {n}",
  successTitle: "Beide Tickets sind da",
  goToScheduling: "Zeit wählen",
  waitingTitle: "Dein Ticket ist gesichert",
  waitingSub: "Jetzt fehlt noch das zweite Ticket.",
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
  payAmount: "{amount} zahlen",
  scopeOnlyMine: "Nur meins bezahlen",
  scopeBoth: "Beide Tickets bezahlen",
  deadlineLabel: "Verbleibend:",
  coverAction: "Ich übernehme das",
  coverConfirm: "Bestätigen",
  coverCancel: "Abbrechen",
  coverConfirmHint: "Tippe auf „Bestätigen“, um das zweite Ticket zu bezahlen",
  walletOne: "{n} Ticket in der Brieftasche",
  walletFew: "{n} Tickets in der Brieftasche",
  walletMany: "{n} Tickets in der Brieftasche",
  walletOther: "{n} Tickets in der Brieftasche",
  walletTopUp: "Nachkaufen",
  securedMine: "Dein Ticket",
};

const pl: TicketStrings = {
  heading: "Wasza randka potrzebuje biletu",
  sub: "Oboje powiedzieliście tak. Po jednym bilecie na osobę — potem wybieracie czas.",
  famineBadge: "−{pct}% dla Ciebie",
  useSelf: "Użyj biletu",
  useBoth: "Użyj 2 biletów",
  coverPartnerTitle: "Opłacić też drugi bilet?",
  coverPartnerSub: "{name} dowie się, że jest już opłacony.",
  premiumCovered: "Premium pokrywa twój bilet ✨",
  premiumCoverNotIncluded: "Premium — tylko za ciebie. Bilet dla {name} — osobno.",
  balanceLabel: "Saldo",
  balanceNote: "Twój portfel: {n}",
  successTitle: "Oba bilety są",
  goToScheduling: "Wybierz godzinę",
  waitingTitle: "Twój bilet jest zaklepany",
  waitingSub: "Czekamy na drugi bilet.",
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
  payAmount: "Zapłać {amount}",
  scopeOnlyMine: "Zapłać tylko za swój",
  scopeBoth: "Zapłać za oba bilety",
  deadlineLabel: "Pozostało:",
  coverAction: "Biorę na siebie",
  coverConfirm: "Potwierdź",
  coverCancel: "Anuluj",
  coverConfirmHint: "Stuknij „Potwierdź”, aby opłacić drugi bilet",
  walletOne: "{n} bilet w portfelu",
  walletFew: "{n} bilety w portfelu",
  walletMany: "{n} biletów w portfelu",
  walletOther: "{n} biletu w portfelu",
  walletTopUp: "Dokup",
  securedMine: "Twój bilet",
};

const dict: Record<Lang, TicketStrings> = { en, ru, uk, de, pl };

export function pickLang(raw: string | null | undefined): Lang {
  if (raw === "ru" || raw === "uk" || raw === "de" || raw === "pl") return raw;
  return "en";
}

export function strings(lang: Lang): TicketStrings {
  return dict[lang] ?? en;
}

/**
 * «N билетов в кошельке» in the language's own plural form — the same forms
 * the native app's `ticket.wallet.balance` carries (one / few / many / other).
 */
export function walletLine(lang: Lang, n: number): string {
  const s = strings(lang);
  const form = new Intl.PluralRules(lang).select(n);
  const tpl =
    form === "one" ? s.walletOne : form === "few" ? s.walletFew : form === "many" ? s.walletMany : s.walletOther;
  return tpl.replaceAll("{n}", String(n));
}

/** Interpolate `{key}` placeholders. */
export function fill(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, v);
  return out;
}
