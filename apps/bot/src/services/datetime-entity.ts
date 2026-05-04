import type { MessageEntity } from "grammy/types";

/**
 * Build a `date_time` MessageEntity for the scheduled-match confirmation.
 *
 * Telegram Bot API 9.5+ introduced the `date_time` entity type: the client
 * renders the wrapped substring in the user's local timezone and makes it
 * tappable (add-to-calendar). We append a placeholder token to the base
 * message and wrap that token in the entity.
 *
 * Reference: https://core.telegram.org/bots/api#messageentity
 *
 * NOTE: grammY's `MessageEntity` union may not include `date_time` in
 * older type bundles. We upcast via `as unknown` so the runtime value is
 * correct while keeping strict type checking elsewhere.
 */

const PLACEHOLDER_TOKEN = "⏰";

export interface DateTimeEntityResult {
  text: string;
  entity: MessageEntity;
}

/**
 * UTF-16 code-unit length — what Telegram uses to count `offset`/`length`
 * on entities. `string.length` already returns UTF-16 code units in JS.
 */
function utf16Length(s: string): number {
  return s.length;
}

/**
 * Append a clickable date_time token to `baseText` wrapped as a `date_time`
 * MessageEntity. The caller should send the returned `text` with the
 * returned `entity` in `entities: [entity]`.
 */
export function buildDateTimeEntity(
  baseText: string,
  when: Date,
): DateTimeEntityResult {
  const separator = "\n\n";
  const prefix = `${baseText}${separator}`;
  const offset = utf16Length(prefix);
  const length = utf16Length(PLACEHOLDER_TOKEN);
  const text = `${prefix}${PLACEHOLDER_TOKEN}`;

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
