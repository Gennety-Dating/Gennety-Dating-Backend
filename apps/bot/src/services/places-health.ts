import { notifyFounderPlacesOutage } from "./founder-notify.js";
import type { VenueRevalidationResult } from "./venue-revalidation.js";

/**
 * Tell the founder when Google Places refused a whole night's re-validation.
 *
 * Why here: the nightly scan is the one Places caller that runs whether or not
 * anybody opened the app, so it is the earliest place an outage is certain. And
 * it is silent by design — a refused request must not deactivate a venue, so
 * the tick counts it and returns normally. Between 2026-08-03 and 2026-11-22
 * that hid four outages, the last of them twenty-one nights long.
 *
 * Only a night in which EVERY place failed counts. A handful of failures is
 * weather; a whole batch is the key, the bill or the network. `NOT_FOUND` is
 * counted as a deactivation by the tick, so it never looks like an outage.
 *
 * One message per failed night, on purpose: no stored state means a restart
 * cannot swallow the alert, and a daily reminder is the right rate for
 * something that only a person can fix. The "answers again" message does need
 * memory and lives in the process, so after a restart it is simply not sent.
 */
let outageReported = false;

export async function reportPlacesHealth(result: VenueRevalidationResult): Promise<void> {
  if (result.scanned === 0) return;

  if (result.failed === result.scanned) {
    outageReported = true;
    await notifyFounderPlacesOutage("down", { failed: result.failed, reason: result.lastFailure });
    return;
  }
  // A night that answered in part is not an outage, and not a recovery either.
  if (outageReported && result.failed === 0) {
    outageReported = false;
    await notifyFounderPlacesOutage("recovered");
  }
}

/** Test seam: the flag is module state and must not leak between tests. */
export function __resetPlacesHealthForTests(): void {
  outageReported = false;
}
