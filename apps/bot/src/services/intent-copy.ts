import { RELATIONSHIP_INTENTS, isRelationshipIntent, t } from "@gennety/shared";
import type { Language, RelationshipIntent } from "@gennety/shared";

/**
 * Localised labels for the relationship-intent axis (PRODUCT_SPEC §1.3).
 *
 * The Mini App carries its own copy of these four strings (`apps/webapp`
 * deliberately does not depend on `@gennety/shared`); this is the bot's side —
 * My Profile and the menu editor. Both must stay in step, because a user picks
 * on one surface and reads the result on the other.
 */
const LABEL_KEYS = {
  spark: "intentSpark",
  open: "intentOpen",
  falling: "intentFalling",
  longterm: "intentLongterm",
} as const satisfies Record<RelationshipIntent, string>;

export function intentLabel(lang: Language, intent: RelationshipIntent): string {
  return t(lang, LABEL_KEYS[intent]);
}

/** Every option in axis order, ready for a keyboard. */
export function intentOptions(
  lang: Language,
): Array<{ value: RelationshipIntent; label: string }> {
  return RELATIONSHIP_INTENTS.map((value) => ({ value, label: intentLabel(lang, value) }));
}

/**
 * The My Profile line. It ALWAYS carries "only you can see this", set or unset:
 * the screen it sits on is framed as "this is how your match sees you", so a
 * line the match will never see has to say so where it is read, not once in a
 * spec (founder decision).
 */
export function intentProfileLine(lang: Language, stored: unknown): string {
  const privateNote = t(lang, "intentPrivateNote");
  if (!isRelationshipIntent(stored)) {
    return t(lang, "myProfileIntentUnset", { privateNote });
  }
  return t(lang, "myProfileIntentLine", {
    intent: intentLabel(lang, stored),
    privateNote,
  });
}
