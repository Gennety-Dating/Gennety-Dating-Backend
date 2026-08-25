import { campusRadarTick } from "../services/campus-radar.js";

/**
 * Hourly sweep for the Bonus Campus Drop (PRODUCT_SPEC §Campus Radar).
 *
 * Registered only when `CAMPUS_DROP_ENABLED`, so a production without the flag
 * runs no extra cron at all — the same shape the synthetic-partner and
 * rematch-refund workers use.
 *
 * Hourly rather than by the minute because what it watches moves in days: a
 * campus's verified cohort grows over a signup push, not over a tick. The tick
 * is cheap when nothing is happening (two grouped counts) and everything it
 * could do is bounded by the cooldown anyway.
 */
export async function campusDropTick(): Promise<void> {
  try {
    const result = await campusRadarTick();
    // Silent on the ordinary tick. A campus that earned a drop and was
    // withheld already logged its own line with the reason; printing "scanned
    // 3, dropped 0" every hour would bury it.
    if (result.dropped.length > 0) {
      console.log(
        `[campus-drop] done: campuses=${result.dropped.length} matches=${result.matchIds.length}`,
      );
    }
  } catch (err) {
    console.error("[campus-drop] tick failed:", err);
  }
}
