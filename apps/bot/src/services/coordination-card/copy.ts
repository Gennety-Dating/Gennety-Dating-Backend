import { t, type Language, type TranslationKey } from "@gennety/shared";

/**
 * Card copy resolution for the pre-date coordination card (PRODUCT_SPEC
 * §Phase 4). The strings themselves live in shared i18n (`coordCard*`); this
 * module only maps a variant onto its keys.
 *
 * The division of labour with the chat message (founder decision 2026-08-01):
 * **the card carries the beat, the message carries what you act on.** A card is
 * a picture — nothing on it is tappable, selectable, or reachable by a screen
 * reader — so instructions and links belong in the caption beside it.
 *
 * One variant is left. The family used to have five — the T-3h offer, the
 * contact ask, the revealed contact and the declined ask — and all four went
 * with the questionnaire on 2026-09-26 (founder decision: no handle exchange,
 * the anonymous chat for every date). The ones that carried a partner's face
 * went with them; the card that remains shows none.
 */

/** The anonymous relay window is open. */
export type CoordCardVariant = "proxy";

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
