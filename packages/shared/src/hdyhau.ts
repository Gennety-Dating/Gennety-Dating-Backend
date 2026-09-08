import type { TranslationKey } from "./i18n.js";

/**
 * HDYHAU — «How did you hear about us», онбординговый вопрос об источнике.
 *
 * Он существует не ради ещё одной колонки в отчёте, а ради ровно одного
 * измерения, которое иначе невозможно: `User.referralSource` говорит, по какой
 * ССЫЛКЕ человек пришёл, а этот ответ — что человек СЧИТАЕТ источником. Когда
 * атрибуция говорит «органика», а человек говорит «друг рассказал лично», это и
 * есть тёмное сарафанное радио: приглашение произошло голосом, ссылки не
 * осталось. Доля таких ответов среди неразмеченного притока — единственная
 * прямая калибровка `K_wom` (`admin/utils/virality.ts` → `hdyhauWomShare`).
 *
 * Перечень ЗАКРЫТ и живёт здесь, а не в клиентах, по той же причине, по которой
 * `CLIENT_EVENT_TYPES` закрыт на сервере: свободный текст в этом поле означал бы
 * PII в аналитической таблице, а расходящиеся списки вариантов у двух клиентов
 * означали бы два несводимых распределения.
 */
export const HDYHAU_ANSWERS = [
  /** Живой человек рассказал при встрече — «чистое» сарафанное радио. */
  "friend_in_person",
  /** Знакомый прислал/написал — тоже человек, но через переписку. */
  "friend_online",
  /** Пост, рилс, сторис, блогер — не адресная рекомендация. */
  "social_media",
  /** Нашёл поиском (Google, поиск Telegram). */
  "search",
  /** Увидел рекламу. */
  "ad",
  /** Живое мероприятие, вечеринка, кампусный дроп. */
  "event",
  /** Не помнит / ничего из перечисленного. */
  "other",
] as const;

export type HdyhauAnswer = (typeof HDYHAU_ANSWERS)[number];

/**
 * Версия формулировки И набора вариантов. Меняется ВМЕСТЕ с любым из двух.
 *
 * Хранится в каждой строке ответа, потому что распределение ответов сравнимо
 * только внутри одной версии: добавить вариант «мероприятие» задним числом и
 * сравнить с периодом, когда его не предлагали, — значит объявить ростом то,
 * что является появлением кнопки.
 */
export const HDYHAU_PROMPT_VERSION = "v1";

/**
 * Ответы, означающие «меня привёл конкретный человек».
 *
 * Соцсети сюда НЕ входят намеренно: пост блогера — это канал, а не адресная
 * рекомендация, и складывать его с «друг рассказал» значит завышать WOM ровно
 * на объём контент-маркетинга. `event` тоже не входит: мероприятие — это
 * оффлайн-канал привлечения, у него есть свои расходы в `ad_spend`.
 */
export const HDYHAU_WOM_ANSWERS: readonly HdyhauAnswer[] = ["friend_in_person", "friend_online"];

const ANSWER_SET = new Set<string>(HDYHAU_ANSWERS);
const WOM_SET = new Set<string>(HDYHAU_WOM_ANSWERS);

export function isHdyhauAnswer(value: string): value is HdyhauAnswer {
  return ANSWER_SET.has(value);
}

/** Считается ли ответ устной (человек-человеку) рекомендацией. */
export function isWordOfMouthAnswer(answer: string): boolean {
  return WOM_SET.has(answer);
}

/**
 * i18n-ключ подписи варианта. Отдельная функция, а не поле в перечне, чтобы
 * значение, попадающее в БД, никогда не зависело от языка читателя.
 */
export function hdyhauAnswerLabelKey(answer: HdyhauAnswer): TranslationKey {
  switch (answer) {
    case "friend_in_person":
      return "hdyhauFriendInPerson";
    case "friend_online":
      return "hdyhauFriendOnline";
    case "social_media":
      return "hdyhauSocialMedia";
    case "search":
      return "hdyhauSearch";
    case "ad":
      return "hdyhauAd";
    case "event":
      return "hdyhauEvent";
    case "other":
      return "hdyhauOther";
  }
}

/** Поверхности, с которых вопрос может быть задан. */
export const HDYHAU_SURFACES = ["tg", "tg-mini", "ios"] as const;
export type HdyhauSurface = (typeof HDYHAU_SURFACES)[number];

export function isHdyhauSurface(value: string): value is HdyhauSurface {
  return (HDYHAU_SURFACES as readonly string[]).includes(value);
}
