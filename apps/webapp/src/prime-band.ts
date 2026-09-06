/**
 * Grouping for the paid evening band inside the time bottom sheet
 * (PRIME_TIME_PRODUCT_SPEC §7).
 *
 * This file decides NOTHING about entitlement. The server sends
 * `primeTime: { locked, slots, stars }` and that is the whole gate; all this
 * does is answer a layout question the renderer would otherwise answer with an
 * index arithmetic that quietly hardcodes the band size:
 *
 *   which row opens the evening section, and which row closes it?
 *
 * The band is a suffix of the grid today (`CALENDAR_TIME_SLOTS.slice(-count)`
 * server-side), but this walks runs instead of assuming a suffix — so a grid
 * that ever gates a non-contiguous set renders two honest sections rather than
 * one section that swallows the free rows between them. `PRIME_TIME_SLOT_COUNT`
 * is never read, guessed, or shown here.
 */

export interface PrimeBandRow {
  /** The slot's canonical ISO, straight from `proposedTimes`. */
  iso: string;
  /** Is this row inside the evening band at all? */
  prime: boolean;
  /** First row of a band run — the section header is inserted above it. */
  bandStart: boolean;
  /** Last row of a band run — the unlock caption is appended below it. */
  bandEnd: boolean;
}

/**
 * Annotate a day's slots with their position in the evening band.
 *
 * `primeSlots` is the server's list verbatim. Rows outside it come back with
 * every flag false and are rendered exactly as they were before this existed.
 */
export function planDayRows(
  isos: readonly string[],
  primeSlots: ReadonlySet<string>,
): PrimeBandRow[] {
  const prime = isos.map((iso) => primeSlots.has(iso));
  return isos.map((iso, i) => ({
    iso,
    prime: prime[i],
    bandStart: prime[i] && !prime[i - 1],
    bandEnd: prime[i] && !prime[i + 1],
  }));
}
