/**
 * Quiet hours guard: 23:00–09:00 UTC.
 *
 * Proactive messages (re-engagement, nudges, announcements) must never be
 * sent during this window. The cron still ticks, but each worker calls this
 * before doing anything.
 */

export const QUIET_START = 23; // 23:00 UTC
export const QUIET_END = 9;    //  09:00 UTC

/**
 * Returns true when the given time (default: now) falls inside quiet hours.
 */
export function isQuietHours(now: Date = new Date()): boolean {
  const hour = now.getUTCHours();
  // Quiet window wraps midnight: [23, 24) ∪ [0, 9)
  return hour >= QUIET_START || hour < QUIET_END;
}
