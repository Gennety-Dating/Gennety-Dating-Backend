/**
 * Venue-change "wish card" (PRODUCT_SPEC §3.7b v2 — the she-asks-him-to-pay
 * moment): a rendered PNG carrying her polaroid photo and the agreed venue,
 * sent to the male with the pay / not-this-time buttons.
 *
 * Returns `null` on ANY failure — the caller (offerPartnerPay) degrades to a
 * text card, so the offer flow never wedges on a render hiccup.
 */

export async function renderVenueWishCard(matchId: string): Promise<Buffer | null> {
  void matchId;
  // PNG render lands in the follow-up stage (satori/resvg, date-card stack);
  // until then the text fallback carries the moment.
  return null;
}
