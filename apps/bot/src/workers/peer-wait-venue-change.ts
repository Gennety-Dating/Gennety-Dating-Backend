import {
  isHeteroPair,
  payerSide,
  type VenuePayerRow,
} from "../handlers/matching/venue-change.js";

/**
 * The peer-wait predicate for the §3.7b venue-change board.
 *
 * The board was originally excluded from the §3.6b shimmer on the grounds that
 * its Mini App already polls at ~4s. That holds only while the Mini App is
 * OPEN — close it and the chat says nothing at all, which is precisely the
 * silence the shimmer exists to fix. Three states there leave one side genuinely
 * blocked on the other, and all three lived in the chat as a blank.
 *
 * Kept in its own module because it is the one branch that needs the payer
 * matrix; the rest of `peer-wait-shimmer.ts` reads plain columns.
 */

/** The venue-change columns the predicate reads, plus the payer-matrix shape. */
export interface VenueChangeWaitRow extends VenuePayerRow {
  status: string;
  venueChangeStatus: string | null;
  /** Server-resolved like snapshots; only the COUNT matters here. */
  venueLikesA: unknown[];
  venueLikesB: unknown[];
  venueChangeOfferPaySentAt: Date | null;
  venueChangeExpressAt: Date | null;
  venueChangePaidAt: Date | null;
}

type Side = "A" | "B";

/**
 * Is this side done with its part of a venue change and now blocked on the
 * partner? Returns false for every state the partner cannot act on.
 */
export function venueChangeSideWaiting(match: VenueChangeWaitRow, side: Side): boolean {
  // The board only exists on a scheduled date.
  if (match.status !== "scheduled") return false;

  const me = side === "A" ? match.userA : match.userB;
  const myLikes = side === "A" ? match.venueLikesA : match.venueLikesB;
  const peerLikes = side === "A" ? match.venueLikesB : match.venueLikesA;

  if (match.venueChangeStatus === "liking") {
    // I hearted something, the partner hasn't opened the board yet.
    return myLikes.length > 0 && peerLikes.length === 0;
  }

  if (match.venueChangeStatus !== "agreed") return false;

  // An express mint is INVISIBLE to the partner until it is paid for — that
  // silence is the product (the surprise card). A shimmer in the non-minter's
  // chat would announce that something is pending, so they are excluded
  // outright; the minter themselves is not waiting on anyone, they are the one
  // who still has to pay.
  if (match.venueChangeExpressAt != null) return false;

  // Already settled — nothing to wait for.
  if (match.venueChangePaidAt != null) return false;

  const payer = payerSide(match);
  if (payer === null) return false;

  // The payer owes the Stars — they have an action, not a wait.
  if (payer === side) return false;

  // Mirrors `buildBoardState`'s `pay_or_offer` vs `wait` split. A hetero female
  // initiator is NOT waiting merely because she isn't the payer: while she can
  // still offer, she holds a live decision of her own (pay it herself, or hand
  // it to him), and he may not even know a swap is pending. She starts waiting
  // at the moment she actually hands it over — the wish card is in his chat and
  // the next move is his.
  const initiatorIsFemale =
    isHeteroPair(match) &&
    ((match.venueChangeProposerId === match.userA.id && match.userA.gender === "female") ||
      (match.venueChangeProposerId === match.userB.id && match.userB.gender === "female"));
  if (initiatorIsFemale && me.gender === "female") {
    return match.venueChangeOfferPaySentAt != null;
  }

  return true;
}
