/**
 * Slot/day state classifiers. Pure functions so they're trivially unit-testable —
 * the visual contract is the load-bearing UX promise of the
 * peer-aware calendar (see PRODUCT_SPEC.md §3.6), so we want it under
 * a real assertion.
 *
 *   empty    — neither side has marked this slot
 *   mine     — current user marked it; partner hasn't
 *   peer     — partner marked it; current user hasn't
 *   overlap  — both sides marked it (drives the "lock in" CTA)
 *   mixed    — same day has both users' picks, but no exact time overlap
 */

export type SlotClass = "empty" | "mine" | "peer" | "overlap";
export type DayClass = SlotClass | "mixed";

export function classifySlot(
  iso: string,
  mine: ReadonlySet<string>,
  peer: ReadonlySet<string>,
): SlotClass {
  const inMine = mine.has(iso);
  const inPeer = peer.has(iso);
  if (inMine && inPeer) return "overlap";
  if (inMine) return "mine";
  if (inPeer) return "peer";
  return "empty";
}

export function classifyDaySlots(
  isos: readonly string[],
  mine: ReadonlySet<string>,
  peer: ReadonlySet<string>,
): DayClass {
  let hasMine = false;
  let hasPeer = false;

  for (const iso of isos) {
    const inMine = mine.has(iso);
    const inPeer = peer.has(iso);
    if (inMine && inPeer) return "overlap";
    hasMine ||= inMine;
    hasPeer ||= inPeer;
  }

  if (hasMine && hasPeer) return "mixed";
  if (hasMine) return "mine";
  if (hasPeer) return "peer";
  return "empty";
}
