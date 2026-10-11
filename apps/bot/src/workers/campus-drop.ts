import type { Api, RawApi } from "grammy";
import { campusRadarTick } from "../services/campus-radar.js";
import { dispatchMatches } from "../services/dispatch-queue.js";

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
export async function campusDropTick(api: Api<RawApi>): Promise<void> {
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
    // The drop only CREATES `proposed` rows; nothing sent their pitches (B-15)
    // until the stranded-proposal sweep found them half an hour later and
    // resumed them as a dead dispatch. Hand them over now, as the scheduled
    // batch does with its own.
    if (result.matchIds.length > 0) {
      const dispatch = await dispatchMatches(api, result.matchIds);
      console.log(
        `[campus-drop] dispatch: sent=${dispatch.dispatched} failed=${dispatch.failed}`,
      );
    }
  } catch (err) {
    console.error("[campus-drop] tick failed:", err);
    // Rethrown (A13-M24): swallowing here meant `guardedTick` saw every tick
    // succeed, so its failure alert could never fire for this job.
    throw err;
  }
}
