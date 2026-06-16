/**
 * Keep a locally cached draft inside the server-provided slot allowlist.
 *
 * DeviceStorage can outlive a match's calendar grid. Before rendering or
 * POSTing a cached selection, normalize every picked ISO to the canonical
 * value from `proposedTimes` and drop anything no longer allowed.
 */
export function pruneSlotsToProposedTimes(
  values: Iterable<string>,
  proposedTimes: readonly string[],
): Set<string> {
  const allowedByTime = new Map<number, string>();
  for (const iso of proposedTimes) {
    const time = new Date(iso).getTime();
    if (!Number.isNaN(time)) allowedByTime.set(time, iso);
  }

  const pruned = new Set<string>();
  for (const value of values) {
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) continue;
    const canonical = allowedByTime.get(time);
    if (canonical) pruned.add(canonical);
  }
  return pruned;
}

export function hasNewSlot(
  selected: Iterable<string>,
  previous: ReadonlySet<string>,
): boolean {
  for (const iso of selected) {
    if (!previous.has(iso)) return true;
  }
  return false;
}
