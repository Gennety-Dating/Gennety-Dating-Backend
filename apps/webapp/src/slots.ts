/**
 * Calendar slot generator — produces the same "next weekday evenings"
 * shape the bot-side scheduler uses. Kept in sync manually; the two
 * code paths are small and won't realistically drift.
 *
 * Pure function, no DOM / Telegram dependency — easy to unit test if we
 * ever add vitest coverage to the webapp.
 */

export function generateSlots(
  now: Date = new Date(),
  count: number = 6,
): Date[] {
  const out: Date[] = [];
  const cursor = new Date(now);
  cursor.setHours(19, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);
  while (out.length < count) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 1) {
      out.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function formatSlot(slot: Date): string {
  return slot.toLocaleString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
