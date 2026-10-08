import { interpolate } from "./i18n.js";
import type { Language } from "./types.js";
import { WISHLIST_AGE_IN_MONTHS_FROM_DAYS, WISHLIST_STALE_AFTER_DAYS } from "./wishlist.js";

/**
 * Copy for «The Morning After», the mutual reveal, the Date Wishlist offer and
 * the wishlist session push (decision journal 2026-10-08).
 *
 * Its own table rather than more keys in `i18n.ts`, the way the Mini App keeps
 * `onboarding-i18n.ts`: the feature ships behind two flags and is read by a
 * handful of call sites, and a separate table keeps the 5,000-line one out of
 * every diff that touches it.
 *
 * Two rules shape the strings:
 *   - **Pushes name nobody.** The lock screen is public (matching-engine.md,
 *     "the copy names nobody"), so the brief's «Как всё прошло вчера с
 *     [Имя]?» is the in-app question and the Telegram DM; the push asks
 *     without the name.
 *   - **Slavic names are not declined.** «с Анной» needs the instrumental case
 *     and a name cannot be declined reliably, so every sentence keeps the name
 *     in the nominative («Анна — как всё прошло вчера?»). Verbs that agree with
 *     the partner's gender come in `F` / `M` pairs.
 *
 * The two research lines (`mutualTiming`, `mutualGift`) are the founder's
 * "80% of second dates…" and "scientists proved… 90%" claims rewritten to what
 * the studies actually say — decision journal 2026-10-08 has the sources. Do
 * not put numbers back in without a source.
 */
const en = {
  morningAfterPushTitle: "How did yesterday go?",
  morningAfterPushBody: "One tap — tell us how the evening went.",
  morningAfterQuestion: "How did yesterday go with {name}?",
  morningAfterGreat: "It was great, I want to meet again",
  morningAfterPass: "Didn't click",
  morningAfterBlind: "{name} will only learn your answer if it's mutual.",
  morningAfterThanksGreat: "Noted. If it's mutual, you'll hear from me right away.",
  morningAfterThanksPass: "Thanks for being honest. Noted.",
  morningAfterExpired: "That question has closed — thanks anyway.",

  mutualPushTitle: "It's mutual ✨",
  mutualPushBody: "You both want to meet again.",
  mutualTitle: "It's mutual ✨",
  mutualBodyF: "{name} had a great time too.",
  mutualBodyM: "{name} had a great time too.",
  mutualTiming:
    "The best moment to write is now: research shows a message the morning after sparks the most interest — two days later it's already fading.",
  mutualGift:
    "And a small gesture runs on the same chemistry: giving something to a person you like lights up the same reward system in the brain as falling in love.",
  flowersHintF: "Her favourite flowers: {flowers}",
  flowersHintM: "His favourite flowers: {flowers}",
  wishlistOfferF: "{name} added ideas for a perfect second date — favourite places, drinks and things.",
  wishlistOfferM: "{name} added ideas for a perfect second date — favourite places, drinks and things.",
  wishlistUnlockStars: "Open the cheat sheet — {stars} ⭐",
  wishlistUnlockPremium: "Open the cheat sheet — included in Premium",
  wishlistSheetTitle: "Cheat sheet: {name}",
  wishlistSheetEmpty: "Nothing on the list yet.",
  wishlistInvoiceTitle: "Date Wishlist",
  wishlistInvoiceDescription: "Second-date cheat sheet — every item on {name}'s wishlist.",
  wishlistUnavailable: "This cheat sheet is no longer available.",

  wishlistSessionPushTitle: "Shall we build your wishlist?",
  wishlistSessionPushBody: "Two minutes — and after a great date you'll get what you actually love.",
} as const;

export type AfterDateKey = keyof typeof en;

const ru: Record<AfterDateKey, string> = {
  morningAfterPushTitle: "Как всё прошло вчера?",
  morningAfterPushBody: "Одно касание — расскажи, как прошёл вечер.",
  morningAfterQuestion: "{name} — как всё прошло вчера?",
  morningAfterGreat: "Было круто, хочу увидеться снова",
  morningAfterPass: "Не сошлись / Мимо",
  morningAfterBlind: "{name} узнает о твоём ответе, только если это взаимно.",
  morningAfterThanksGreat: "Записал. Если это взаимно — сразу скажу.",
  morningAfterThanksPass: "Спасибо за честность. Учту.",
  morningAfterExpired: "Этот вопрос уже закрыт — всё равно спасибо.",

  mutualPushTitle: "Взаимно ✨",
  mutualPushBody: "Вы оба хотите увидеться снова.",
  mutualTitle: "Взаимно ✨",
  mutualBodyF: "{name} тоже отлично провела время.",
  mutualBodyM: "{name} тоже отлично провёл время.",
  mutualTiming:
    "Лучшее время написать — сейчас: исследования показывают, что сообщение на следующее утро вызывает больше всего интереса, а через два дня он уже угасает.",
  mutualGift:
    "А маленький знак внимания работает на той же «химии»: подарок человеку, который нравится, включает ту же систему вознаграждения мозга, что и влюблённость.",
  flowersHintF: "Её любимые цветы: {flowers}",
  flowersHintM: "Его любимые цветы: {flowers}",
  wishlistOfferF: "{name} добавила идеи для идеального второго свидания — любимые места, напитки и вещи.",
  wishlistOfferM: "{name} добавил идеи для идеального второго свидания — любимые места, напитки и вещи.",
  wishlistUnlockStars: "Открыть шпаргалку — {stars} ⭐",
  wishlistUnlockPremium: "Открыть шпаргалку — входит в Premium",
  wishlistSheetTitle: "Шпаргалка: {name}",
  wishlistSheetEmpty: "В списке пока пусто.",
  wishlistInvoiceTitle: "Date Wishlist",
  wishlistInvoiceDescription: "Шпаргалка ко второму свиданию — весь вишлист ({name}).",
  wishlistUnavailable: "Эта шпаргалка больше недоступна.",

  wishlistSessionPushTitle: "Соберём твой вишлист?",
  wishlistSessionPushBody:
    "Пара минут — и после удачного свидания тебя порадуют тем, что ты действительно любишь.",
};

const uk: Record<AfterDateKey, string> = {
  morningAfterPushTitle: "Як усе минуло вчора?",
  morningAfterPushBody: "Один дотик — розкажи, як минув вечір.",
  morningAfterQuestion: "{name} — як усе минуло вчора?",
  morningAfterGreat: "Було класно, хочу побачитися знову",
  morningAfterPass: "Не зійшлися / Повз",
  morningAfterBlind: "{name} дізнається про твою відповідь, лише якщо це взаємно.",
  morningAfterThanksGreat: "Записав. Якщо це взаємно — одразу скажу.",
  morningAfterThanksPass: "Дякую за чесність. Врахую.",
  morningAfterExpired: "Це питання вже закрите — все одно дякую.",

  mutualPushTitle: "Взаємно ✨",
  mutualPushBody: "Ви обоє хочете побачитися знову.",
  mutualTitle: "Взаємно ✨",
  mutualBodyF: "{name} теж чудово провела час.",
  mutualBodyM: "{name} теж чудово провів час.",
  mutualTiming:
    "Найкращий час написати — зараз: дослідження показують, що повідомлення наступного ранку викликає найбільше інтересу, а за два дні він уже згасає.",
  mutualGift:
    "А маленький знак уваги працює на тій самій «хімії»: подарунок людині, яка подобається, вмикає ту саму систему винагороди мозку, що й закоханість.",
  flowersHintF: "Її улюблені квіти: {flowers}",
  flowersHintM: "Його улюблені квіти: {flowers}",
  wishlistOfferF: "{name} додала ідеї для ідеального другого побачення — улюблені місця, напої та речі.",
  wishlistOfferM: "{name} додав ідеї для ідеального другого побачення — улюблені місця, напої та речі.",
  wishlistUnlockStars: "Відкрити шпаргалку — {stars} ⭐",
  wishlistUnlockPremium: "Відкрити шпаргалку — входить у Premium",
  wishlistSheetTitle: "Шпаргалка: {name}",
  wishlistSheetEmpty: "У списку поки порожньо.",
  wishlistInvoiceTitle: "Date Wishlist",
  wishlistInvoiceDescription: "Шпаргалка до другого побачення — весь вішліст ({name}).",
  wishlistUnavailable: "Ця шпаргалка більше недоступна.",

  wishlistSessionPushTitle: "Зберемо твій вішліст?",
  wishlistSessionPushBody:
    "Кілька хвилин — і після вдалого побачення тебе потішать тим, що ти справді любиш.",
};

const de: Record<AfterDateKey, string> = {
  morningAfterPushTitle: "Wie war es gestern?",
  morningAfterPushBody: "Ein Tipp – erzähl uns, wie der Abend war.",
  morningAfterQuestion: "Wie war es gestern mit {name}?",
  morningAfterGreat: "War toll, ich will mich wiedersehen",
  morningAfterPass: "Hat nicht gepasst",
  morningAfterBlind: "{name} erfährt deine Antwort nur, wenn es gegenseitig ist.",
  morningAfterThanksGreat: "Notiert. Wenn es gegenseitig ist, sag ich's dir sofort.",
  morningAfterThanksPass: "Danke für deine Ehrlichkeit. Notiert.",
  morningAfterExpired: "Diese Frage ist schon geschlossen – trotzdem danke.",

  mutualPushTitle: "Gegenseitig ✨",
  mutualPushBody: "Ihr wollt euch beide wiedersehen.",
  mutualTitle: "Gegenseitig ✨",
  mutualBodyF: "{name} hatte auch einen tollen Abend.",
  mutualBodyM: "{name} hatte auch einen tollen Abend.",
  mutualTiming:
    "Der beste Moment zu schreiben ist jetzt: Studien zeigen, dass eine Nachricht am Morgen danach das meiste Interesse weckt – nach zwei Tagen lässt es schon nach.",
  mutualGift:
    "Und eine kleine Aufmerksamkeit wirkt über dieselbe Chemie: Jemandem, den man mag, etwas zu schenken, aktiviert dasselbe Belohnungssystem im Gehirn wie Verliebtsein.",
  flowersHintF: "Ihre Lieblingsblumen: {flowers}",
  flowersHintM: "Seine Lieblingsblumen: {flowers}",
  wishlistOfferF: "{name} hat Ideen für das perfekte zweite Date hinterlegt – Lieblingsorte, Drinks und Dinge.",
  wishlistOfferM: "{name} hat Ideen für das perfekte zweite Date hinterlegt – Lieblingsorte, Drinks und Dinge.",
  wishlistUnlockStars: "Spickzettel öffnen – {stars} ⭐",
  wishlistUnlockPremium: "Spickzettel öffnen – in Premium enthalten",
  wishlistSheetTitle: "Spickzettel: {name}",
  wishlistSheetEmpty: "Noch nichts auf der Liste.",
  wishlistInvoiceTitle: "Date Wishlist",
  wishlistInvoiceDescription: "Spickzettel fürs zweite Date – die ganze Wunschliste von {name}.",
  wishlistUnavailable: "Dieser Spickzettel ist nicht mehr verfügbar.",

  wishlistSessionPushTitle: "Stellen wir deine Wunschliste zusammen?",
  wishlistSessionPushBody: "Zwei Minuten – und nach einem schönen Date bekommst du, was du wirklich magst.",
};

const pl: Record<AfterDateKey, string> = {
  morningAfterPushTitle: "Jak było wczoraj?",
  morningAfterPushBody: "Jedno dotknięcie — powiedz, jak minął wieczór.",
  morningAfterQuestion: "{name} — jak było wczoraj?",
  morningAfterGreat: "Było super, chcę się znów spotkać",
  morningAfterPass: "Nie zaiskrzyło",
  morningAfterBlind: "{name} pozna twoją odpowiedź tylko wtedy, gdy to będzie wzajemne.",
  morningAfterThanksGreat: "Zapisane. Jeśli to wzajemne — od razu dam znać.",
  morningAfterThanksPass: "Dzięki za szczerość. Zapisane.",
  morningAfterExpired: "To pytanie jest już zamknięte — i tak dziękuję.",

  mutualPushTitle: "Z wzajemnością ✨",
  mutualPushBody: "Oboje chcecie się znów spotkać.",
  mutualTitle: "Z wzajemnością ✨",
  mutualBodyF: "{name} też świetnie się bawiła.",
  mutualBodyM: "{name} też świetnie się bawił.",
  mutualTiming:
    "Najlepszy moment, by napisać, jest teraz: badania pokazują, że wiadomość następnego ranka budzi największe zainteresowanie — po dwóch dniach już słabnie.",
  mutualGift:
    "A drobny gest działa na tej samej «chemii»: obdarowanie kogoś, kto ci się podoba, uruchamia w mózgu ten sam układ nagrody co zakochanie.",
  flowersHintF: "Jej ulubione kwiaty: {flowers}",
  flowersHintM: "Jego ulubione kwiaty: {flowers}",
  wishlistOfferF: "{name} dodała pomysły na idealną drugą randkę — ulubione miejsca, napoje i rzeczy.",
  wishlistOfferM: "{name} dodał pomysły na idealną drugą randkę — ulubione miejsca, napoje i rzeczy.",
  wishlistUnlockStars: "Otwórz ściągę — {stars} ⭐",
  wishlistUnlockPremium: "Otwórz ściągę — w ramach Premium",
  wishlistSheetTitle: "Ściąga: {name}",
  wishlistSheetEmpty: "Na liście jeszcze nic nie ma.",
  wishlistInvoiceTitle: "Date Wishlist",
  wishlistInvoiceDescription: "Ściąga na drugą randkę — cała lista życzeń ({name}).",
  wishlistUnavailable: "Ta ściąga nie jest już dostępna.",

  wishlistSessionPushTitle: "Zbierzemy twoją listę życzeń?",
  wishlistSessionPushBody: "Dwie minuty — a po udanej randce dostaniesz to, co naprawdę lubisz.",
};

const tables: Record<Language, Record<AfterDateKey, string>> = { en, ru, uk, de, pl };

export function afterDateT(
  lang: Language,
  key: AfterDateKey,
  params?: Record<string, string | number>,
): string {
  const table = tables[lang] ?? tables.en;
  return interpolate(table[key] ?? tables.en[key], params);
}

/** The `F` / `M` variant of a gendered key, by the PARTNER's gender. */
export function afterDateGendered(
  lang: Language,
  base: "mutualBody" | "flowersHint" | "wishlistOffer",
  partnerGender: string | null | undefined,
  params?: Record<string, string | number>,
): string {
  const key = `${base}${partnerGender === "male" ? "M" : "F"}` as AfterDateKey;
  return afterDateT(lang, key, params);
}

function slavicPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Polish keeps the singular for 1 alone: 21 → "pozycji", not "pozycja". */
function polishPlural(n: number, one: string, few: string, many: string): string {
  return n === 1 ? one : slavicPlural(n, many, few, many);
}

/** "N more items" on the locked part of the cheat sheet (the brief: «Ещё 5 позиций»). */
export function wishlistMoreLabel(lang: Language, n: number): string {
  switch (lang) {
    case "ru":
      return `Ещё ${n} ${slavicPlural(n, "позиция", "позиции", "позиций")}`;
    case "uk":
      return `Ще ${n} ${slavicPlural(n, "позиція", "позиції", "позицій")}`;
    case "pl":
      return `Jeszcze ${n} ${polishPlural(n, "pozycja", "pozycje", "pozycji")}`;
    case "de":
      return `Noch ${n} ${n === 1 ? "Eintrag" : "Einträge"}`;
    default:
      return `${n} more ${n === 1 ? "item" : "items"}`;
  }
}

/**
 * The cheat sheet's small "last updated N days ago" line (founder 2026-10-08):
 * null while the list is fresher than `WISHLIST_STALE_AFTER_DAYS`, so a recent
 * list carries no line at all. Months from `WISHLIST_AGE_IN_MONTHS_FROM_DAYS`.
 */
export function wishlistAgeNote(lang: Language, ageDays: number): string | null {
  if (!Number.isFinite(ageDays) || ageDays < WISHLIST_STALE_AFTER_DAYS) return null;
  const days = Math.floor(ageDays);
  const months = days >= WISHLIST_AGE_IN_MONTHS_FROM_DAYS ? Math.floor(days / 30) : 0;
  const n = months || days;
  switch (lang) {
    case "ru": {
      const unit = months
        ? slavicPlural(n, "месяц", "месяца", "месяцев")
        : slavicPlural(n, "день", "дня", "дней");
      return `Список обновлялся ${n} ${unit} назад — что-то могло устареть.`;
    }
    case "uk": {
      const unit = months
        ? slavicPlural(n, "місяць", "місяці", "місяців")
        : slavicPlural(n, "день", "дні", "днів");
      return `Список оновлювався ${n} ${unit} тому — дещо могло застаріти.`;
    }
    case "pl": {
      const unit = months
        ? polishPlural(n, "miesiąc", "miesiące", "miesięcy")
        : n === 1 ? "dzień" : "dni";
      return `Lista zmieniana ${n} ${unit} temu — coś mogło się zdezaktualizować.`;
    }
    case "de": {
      const unit = months ? (n === 1 ? "Monat" : "Monaten") : n === 1 ? "Tag" : "Tagen";
      return `Zuletzt vor ${n} ${unit} geändert — manches ist vielleicht nicht mehr aktuell.`;
    }
    default: {
      const unit = months ? (n === 1 ? "month" : "months") : n === 1 ? "day" : "days";
      return `Last updated ${n} ${unit} ago — some ideas may be out of date.`;
    }
  }
}

/** Every key, for the parity test. */
export const AFTER_DATE_KEYS = Object.keys(en) as AfterDateKey[];
export const AFTER_DATE_TABLES = tables;
