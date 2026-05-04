/**
 * Quiet hours guard — 23:00–09:00 Europe/Kyiv.
 *
 * Proactive messages (re-engagement, nudges, announcements) must never be
 * sent during this window. The cron still ticks; each worker calls
 * `isQuietHours` before sending.
 *
 * The hour is read in Kyiv local time (DST-aware) via Intl.DateTimeFormat,
 * matching `re-engagement-schedule.ts` and PRODUCT_SPEC. Pre-C-8 this
 * function used `getUTCHours()`, which in summer (Kyiv = UTC+3) shifted
 * the quiet window to 02:00–12:00 local — silencing the bot at peak hours
 * and firing nudges at 06:00.
 */

export const QUIET_START = 23; // 23:00 Kyiv
export const QUIET_END = 9; //  09:00 Kyiv
export const QUIET_TZ = "Europe/Kyiv";

/**
 * Returns true when the given moment falls inside the Kyiv quiet window
 * [23:00, 09:00). Wraps midnight, so the window is [23, 24) ∪ [0, 9).
 */
export function isQuietHours(now: Date = new Date()): boolean {
  const hour = getKyivHour(now);
  return hour >= QUIET_START || hour < QUIET_END;
}

/** Read the Kyiv local hour (0..23) from a UTC Date, DST-aware. */
function getKyivHour(date: Date): number {
  // Intl emits "24" for midnight in some envs; mod 24 keeps the range tight.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUIET_TZ,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(raw) % 24;
}
