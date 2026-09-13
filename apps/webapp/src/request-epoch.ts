/**
 * Which poll response is still allowed to paint (A13-L23).
 *
 * The calendar and the ticket gate both poll on a timer AND write on a tap. A
 * poll that left before a write and lands after it carries the world as it was
 * before the write — painting it rolls the screen back over the user's own
 * save (a slot they just picked disappears, a paid gate shows its pay button).
 * Checking a `saving` flag before the fetch cannot catch that: the flag was
 * clear when the request left. Two reads can overtake each other the same way.
 *
 * So every read takes a ticket when it starts, and its response paints only if
 *   - no write has started since that ticket was issued, and
 *   - no NEWER read has already painted.
 *
 * "Newer read painted", not "newer read started": the ticket gate's read waits
 * on a photo preload that can outlast its own 4 s interval, and dropping every
 * read the moment the next one leaves would starve the screen of any update.
 */

export interface ResponseEpoch {
  /** Call as a read starts; keep the ticket for when it lands. */
  begin(): number;
  /** Call as a write starts and again as its answer is applied. */
  invalidate(): void;
  /**
   * Whether the read holding `ticket` may paint. A `true` answer is recorded,
   * so every read older than this one is refused from then on.
   */
  claim(ticket: number): boolean;
}

export function createResponseEpoch(): ResponseEpoch {
  let sequence = 0;
  /** Tickets at or below this were issued before the latest write. */
  let writeFloor = 0;
  /** The newest ticket that has painted. */
  let painted = 0;
  return {
    begin(): number {
      sequence += 1;
      return sequence;
    },
    invalidate(): void {
      sequence += 1;
      writeFloor = sequence;
    },
    claim(ticket: number): boolean {
      if (ticket <= writeFloor || ticket <= painted) return false;
      painted = ticket;
      return true;
    },
  };
}
