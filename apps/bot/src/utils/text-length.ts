/**
 * Message length as the person sees it (audit C-17).
 *
 * iOS counts a `String` in Characters — extended grapheme clusters — while
 * JavaScript's `.length` counts UTF-16 code units. One emoji is one Character
 * but two to a dozen code units, so a message the app let through ("1000 of
 * 1000") could be refused here as too long. Counting graphemes on the server
 * makes the server's limit never stricter than the client's for real text.
 *
 * Graphemes alone would let one "character" carry thousands of combining
 * marks, so the raw size keeps a ceiling too: `utf16Ceiling`, four code units
 * per allowed grapheme by default — more than an emoji-heavy message averages,
 * and still a hard bound on what is stored and relayed.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeLength(text: string): number {
  return Array.from(segmenter.segment(text)).length;
}

export function exceedsVisibleLength(text: string, max: number, utf16Ceiling = max * 4): boolean {
  // Every grapheme is at least one code unit, so a short string is settled
  // without segmenting it.
  if (text.length <= max) return false;
  if (text.length > utf16Ceiling) return true;
  return graphemeLength(text) > max;
}
