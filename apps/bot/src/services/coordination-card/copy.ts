import type { Language } from "@gennety/shared";

/**
 * Card copy for the pre-date coordination card family (PRODUCT_SPEC §Phase 4).
 *
 * MOCKUP STAGE — deliberately local, not in `packages/shared/src/i18n.ts` yet.
 * These strings exist only inside the rendered PNG (they are never sent as chat
 * text), and the whole family is still being reviewed, so keeping five locales
 * of one card next to its layout is what makes a wording pass a single edit
 * instead of five edits 1000 lines apart. The table is shaped exactly like an
 * i18n block, so moving it into shared i18n at wiring time is a copy-paste.
 *
 * Copy constraints the layout depends on:
 *  - `head` is exactly two lines; the SECOND one takes the burgundy accent.
 *  - Headline lines stay short (~14 Cyrillic / ~18 Latin chars) — the display
 *    faces are wide and a third wrapped line breaks the vertical rhythm.
 *  - No emoji anywhere: the bundled fonts carry no color-emoji glyphs and
 *    satori silently drops them. Emoji live in the Telegram caption instead.
 *
 * The division of labour with the chat message (founder decision 2026-08-01):
 * **the card carries the beat, the message carries what you act on.** A card
 * is a picture — nothing on it is tappable, selectable, or readable by a screen
 * reader — so instructions and links belong in the text beside it, and the two
 * repeating each other just costs the card its air. That is why `shared` and
 * `declined` carry NO sub-line: what they used to say already lives verbatim in
 * `coordRevealToInitiator` / `coordSharedToPartner` and `coordPartnerDeclined`.
 */

/** One card per real send in the coordination flow. */
export type CoordCardVariant =
  /** T-60m: the initiator picks how to coordinate. Photo = the partner. */
  | "offer"
  /** Variant B: the partner is asked to share their Telegram. Photo = asker. */
  | "ask"
  /** Variant A/B-approved: a contact was revealed. Photo = the contact owner. */
  | "shared"
  /** Variant B declined — soft no, points at the anonymous-chat fallback. */
  | "declined"
  /** Variant C: the anonymous relay window is open. */
  | "proxy";

export interface CoordCardCopy {
  /** Small uppercase, letter-spaced label above the headline. */
  kicker: string;
  /** Exactly two display lines; the second is accented. */
  head: [string, string];
  /**
   * One muted sentence under the headline. May carry `{name}`. Omitted where
   * the chat message already says it (see the header note) — the layout then
   * spends the freed height on the gap under the brand lockup instead.
   */
  sub?: string;
}

type VariantCopy = Record<CoordCardVariant, CoordCardCopy>;

const en: VariantCopy = {
  offer: {
    kicker: "ONE HOUR TO GO",
    head: ["Find each", "other."],
    sub: "Pick how you'll connect at the spot — contacts, or an anonymous chat.",
  },
  ask: {
    kicker: "CONTACT REQUEST",
    head: ["Share your", "Telegram?"],
    sub: "{name} wants a way to find you at the spot. Your call.",
  },
  shared: {
    kicker: "CONTACT UNLOCKED",
    head: ["You're", "connected."],
  },
  declined: {
    kicker: "NO CONTACTS",
    head: ["Not this", "time."],
  },
  proxy: {
    kicker: "ANONYMOUS CHAT",
    head: ["The line", "is open."],
    sub: "Messages go through me. No contacts are revealed.",
  },
};

const ru: VariantCopy = {
  offer: {
    kicker: "ЧАС ДО ВСТРЕЧИ",
    head: ["Найдите", "друг друга."],
    sub: "Выбери, как связаться на месте — контакты или анонимный чат.",
  },
  ask: {
    kicker: "ЗАПРОС КОНТАКТА",
    head: ["Поделиться", "Telegram?"],
    sub: "{name} хочет найти тебя на месте. Решать тебе.",
  },
  shared: {
    kicker: "КОНТАКТ ОТКРЫТ",
    head: ["Теперь вы", "на связи."],
  },
  declined: {
    kicker: "БЕЗ КОНТАКТОВ",
    head: ["Не в этот", "раз."],
  },
  proxy: {
    kicker: "АНОНИМНЫЙ ЧАТ",
    head: ["Линия", "открыта."],
    sub: "Сообщения идут через меня. Контакты не раскрываются.",
  },
};

const uk: VariantCopy = {
  offer: {
    kicker: "ГОДИНА ДО ЗУСТРІЧІ",
    head: ["Знайдіть", "одне одного."],
    sub: "Обери, як звʼязатися на місці — контакти або анонімний чат.",
  },
  ask: {
    kicker: "ЗАПИТ КОНТАКТУ",
    head: ["Поділитися", "Telegram?"],
    sub: "{name} хоче знайти тебе на місці. Вирішувати тобі.",
  },
  shared: {
    kicker: "КОНТАКТ ВІДКРИТО",
    head: ["Тепер ви", "на звʼязку."],
  },
  declined: {
    kicker: "БЕЗ КОНТАКТІВ",
    head: ["Не цього", "разу."],
  },
  proxy: {
    kicker: "АНОНІМНИЙ ЧАТ",
    head: ["Лінія", "відкрита."],
    sub: "Повідомлення йдуть через мене. Контакти не розкриваються.",
  },
};

const de: VariantCopy = {
  offer: {
    kicker: "NOCH EINE STUNDE",
    head: ["Findet", "einander."],
    sub: "Wähle, wie ihr euch vor Ort erreicht — Kontakte oder anonymer Chat.",
  },
  ask: {
    kicker: "KONTAKTANFRAGE",
    head: ["Telegram", "teilen?"],
    sub: "{name} möchte dich vor Ort finden können. Deine Entscheidung.",
  },
  shared: {
    kicker: "KONTAKT FREI",
    head: ["Ihr seid", "verbunden."],
  },
  declined: {
    kicker: "KEINE KONTAKTE",
    head: ["Diesmal", "nicht."],
  },
  proxy: {
    kicker: "ANONYMER CHAT",
    head: ["Die Leitung", "ist offen."],
    sub: "Nachrichten laufen über mich. Keine Kontakte werden geteilt.",
  },
};

const pl: VariantCopy = {
  offer: {
    kicker: "GODZINA DO SPOTKANIA",
    head: ["Znajdźcie", "się."],
    sub: "Wybierz, jak się skontaktować na miejscu — kontakt albo anonimowy czat.",
  },
  ask: {
    kicker: "PROŚBA O KONTAKT",
    head: ["Udostępnić", "Telegram?"],
    sub: "{name} chce cię znaleźć na miejscu. Twoja decyzja.",
  },
  shared: {
    kicker: "KONTAKT OTWARTY",
    head: ["Jesteście", "w kontakcie."],
  },
  declined: {
    kicker: "BEZ KONTAKTÓW",
    head: ["Nie tym", "razem."],
  },
  proxy: {
    kicker: "ANONIMOWY CZAT",
    head: ["Linia", "otwarta."],
    sub: "Wiadomości idą przeze mnie. Kontakty pozostają ukryte.",
  },
};

const COPY: Record<Language, VariantCopy> = { en, ru, uk, de, pl };

/** Resolve a variant's copy, interpolating `{name}` into the sub-line. */
export function coordCardCopy(
  language: Language,
  variant: CoordCardVariant,
  name: string,
): CoordCardCopy {
  const table = COPY[language] ?? en;
  const entry = table[variant];
  // Under `exactOptionalPropertyTypes` a sub-less variant has to OMIT the key
  // rather than carry an explicit `undefined`.
  return entry.sub === undefined
    ? { kicker: entry.kicker, head: entry.head }
    : { ...entry, sub: entry.sub.replace("{name}", name) };
}
