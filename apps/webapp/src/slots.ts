/**
 * Slot label formatter. Pure function, easy to unit-test.
 *
 * Slot generation moved server-side: the bot writes the canonical grid
 * into `Match.proposedTimes` when scheduling starts, and the Mini App
 * reads it via `GET /v1/calendar/state`. Keeping it server-side means
 * both users see the same grid (and the POST validator can reject any
 * timestamp not on that allowlist).
 *
 * **Every function here takes the zone explicitly.** They used to format in the
 * DEVICE zone, which meant a traveller read one time for a slot in the browser
 * and a different one for the same instant in the chat — and, worse, the grid
 * grouped into the wrong calendar days, so the day buttons themselves were off.
 * The zone belongs to the market, not to the phone: `GET /v1/calendar/state`
 * sends it, and the event card next door (`event.ts`) already stated the rule —
 * the event's own city clock, never the device's.
 */

/**
 * Zone to use before the first `state` response lands. `apps/webapp`
 * deliberately does not depend on `@gennety/shared`, so this mirrors
 * `DEFAULT_TIME_ZONE` there; the server's value wins the moment it arrives.
 */
export const FALLBACK_TIME_ZONE = "Europe/Kyiv";

function localeFor(lang: string): string | undefined {
  if (lang === "ru") return "ru-RU";
  if (lang === "uk") return "uk-UA";
  if (lang === "de") return "de-DE";
  if (lang === "pl") return "pl-PL";
  return undefined;
}

export function formatSlot(slot: Date, lang: string, timeZone: string): string {
  return slot.toLocaleString(localeFor(lang), {
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

export function formatDate(slot: Date, lang: string, timeZone: string): string {
  return slot.toLocaleDateString(localeFor(lang), {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone,
  });
}

export function formatTime(slot: Date, lang: string, timeZone: string): string {
  return slot.toLocaleTimeString(localeFor(lang), {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

/**
 * `YYYY-MM-DD` of the slot in the market's zone — the key the grid groups by.
 *
 * Built from `formatToParts` rather than `toISOString().slice(0, 10)`: the
 * latter is the UTC day, and a 19:30 Kyiv slot in summer is 16:30 UTC on the
 * same date but a 00:30 slot would not be. `en-CA` would give the right shape
 * directly, but assembling the parts keeps the output independent of whatever
 * locale data the browser ships.
 */
export function slotDayKey(slot: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(slot);
  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")}`;
}
