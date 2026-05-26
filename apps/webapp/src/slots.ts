/**
 * Slot label formatter. Pure function, easy to unit-test.
 *
 * Slot generation moved server-side: the bot writes the canonical grid
 * into `Match.proposedTimes` when scheduling starts, and the Mini App
 * reads it via `GET /v1/calendar/state`. Keeping it server-side means
 * both users see the same grid (and the POST validator can reject any
 * timestamp not on that allowlist).
 */

function localeFor(lang: string): string | undefined {
  if (lang === "ru") return "ru-RU";
  if (lang === "uk") return "uk-UA";
  if (lang === "de") return "de-DE";
  if (lang === "pl") return "pl-PL";
  return undefined;
}

export function formatSlot(slot: Date, lang: string): string {
  const locale = localeFor(lang);
  return slot.toLocaleString(locale, {
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(slot: Date, lang: string): string {
  const locale = localeFor(lang);
  return slot.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

export function formatTime(slot: Date, lang: string): string {
  const locale = localeFor(lang);
  return slot.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function slotDayKey(slot: Date): string {
  const year = slot.getFullYear();
  const month = String(slot.getMonth() + 1).padStart(2, "0");
  const day = String(slot.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
