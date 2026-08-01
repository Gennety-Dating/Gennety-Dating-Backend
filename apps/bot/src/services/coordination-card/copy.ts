import { t, type Language, type TranslationKey } from "@gennety/shared";

/**
 * Card copy resolution for the pre-date coordination card family
 * (PRODUCT_SPEC §Phase 4). The strings themselves live in shared i18n
 * (`coordCard*`); this module only maps a variant onto its keys.
 *
 * The division of labour with the chat message (founder decision 2026-08-01):
 * **the card carries the beat, the message carries what you act on.** A card is
 * a picture — nothing on it is tappable, selectable, or reachable by a screen
 * reader — so instructions and links belong in the caption beside it, and the
 * two repeating each other just costs the card its air. That is why `shared`
 * and `declined` have no `sub` key at all: what they used to say already lives
 * verbatim in `coordRevealToInitiator` / `coordSharedToPartner` and
 * `coordPartnerDeclined`, which is the caption those two cards ride on.
 */

/** One card per real send in the coordination flow. */
export type CoordCardVariant =
  /** T-60m: the initiator picks how to coordinate. Photo = the partner. */
  | "offer"
  /** Variant B: the partner is asked to share their Telegram. Photo = asker. */
  | "ask"
  /** Variant A/B-approved: a contact was revealed. Photo = the contact owner. */
  | "shared"
  /** Variant B declined — soft no; the fallback lives in the caption. */
  | "declined"
  /** Variant C: the anonymous relay window is open. */
  | "proxy";

export interface CoordCardCopy {
  /** Small uppercase, letter-spaced label above the headline. */
  kicker: string;
  /** Exactly two display lines; the second takes the burgundy accent. */
  head: [string, string];
  /** One muted sentence under the headline; absent where the caption says it. */
  sub?: string;
}

interface VariantKeys {
  kicker: TranslationKey;
  head: readonly [TranslationKey, TranslationKey];
  sub?: TranslationKey;
}

const KEYS: Record<CoordCardVariant, VariantKeys> = {
  offer: {
    kicker: "coordCardOfferKicker",
    head: ["coordCardOfferHead1", "coordCardOfferHead2"],
    sub: "coordCardOfferSub",
  },
  ask: {
    kicker: "coordCardAskKicker",
    head: ["coordCardAskHead1", "coordCardAskHead2"],
    sub: "coordCardAskSub",
  },
  shared: {
    kicker: "coordCardSharedKicker",
    head: ["coordCardSharedHead1", "coordCardSharedHead2"],
  },
  declined: {
    kicker: "coordCardDeclinedKicker",
    head: ["coordCardDeclinedHead1", "coordCardDeclinedHead2"],
  },
  proxy: {
    kicker: "coordCardProxyKicker",
    head: ["coordCardProxyHead1", "coordCardProxyHead2"],
    sub: "coordCardProxySub",
  },
};

/** Resolve a variant's copy, interpolating `{name}` into the sub-line. */
export function coordCardCopy(
  language: Language,
  variant: CoordCardVariant,
  name: string,
): CoordCardCopy {
  const keys = KEYS[variant];
  const head: [string, string] = [t(language, keys.head[0]), t(language, keys.head[1])];
  // Under `exactOptionalPropertyTypes` a sub-less variant has to OMIT the key
  // rather than carry an explicit `undefined`.
  return keys.sub === undefined
    ? { kicker: t(language, keys.kicker), head }
    : { kicker: t(language, keys.kicker), head, sub: t(language, keys.sub, { name }) };
}
