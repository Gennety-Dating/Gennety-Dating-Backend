import type { MessageEntity } from "grammy/types";
import type { Language } from "@gennety/shared";

/**
 * Build a `date_time` MessageEntity for the scheduled-match confirmation.
 *
 * Telegram Bot API 9.5+ introduced the `date_time` entity type: tapping the
 * wrapped substring opens the user's local-timezone add-to-calendar sheet
 * driven by `unix_time`. The client does NOT auto-style the wrapped text
 * (no underline / chip), so the wrapped substring must look obviously
 * tappable on its own. We render a localized date string + leading 📅
 * affordance and wrap the whole phrase as the entity's tap target.
 *
 * Reference: https://core.telegram.org/bots/api#messageentity
 *
 * NOTE: grammY's `MessageEntity` union may not include `date_time` in
 * older type bundles. We upcast via `as unknown` so the runtime value is
 * correct while keeping strict type checking elsewhere.
 */

const RENDER_TZ = "Europe/Kyiv";
const CALENDAR_AFFORDANCE = "📅 ";

const LOCALE_TAGS: Record<Language, string> = {
  en: "en-GB",
  ru: "ru-RU",
  uk: "uk-UA",
  de: "de-DE",
  pl: "pl-PL",
};

export interface DateTimeEntityResult {
  text: string;
  entity: MessageEntity;
}

function utf16Length(s: string): number {
  return s.length;
}

function renderDate(when: Date, language: Language): string {
  const fmt = new Intl.DateTimeFormat(LOCALE_TAGS[language], {
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: RENDER_TZ,
  });
  return fmt.format(when);
}

/**
 * Append a clickable, localized date phrase to `baseText` and return it
 * wrapped as a `date_time` MessageEntity. The caller should send the
 * returned `text` with `entities: [entity]`.
 */
export function buildDateTimeEntity(
  baseText: string,
  when: Date,
  language: Language,
): DateTimeEntityResult {
  const separator = "\n\n";
  const placeholder = `${CALENDAR_AFFORDANCE}${renderDate(when, language)}`;
  const prefix = `${baseText}${separator}`;
  const offset = utf16Length(prefix);
  const length = utf16Length(placeholder);
  const text = `${prefix}${placeholder}`;

  // `date_time` entity carries the unix timestamp (seconds) in `unix_time`.
  // Confirmed empirically: Telegram rejects `timestamp` with
  // `can't parse MessageEntity: Can't find field "unix_time"`.
  const entity = {
    type: "date_time",
    offset,
    length,
    unix_time: Math.floor(when.getTime() / 1000),
  } as unknown as MessageEntity;

  return { text, entity };
}
