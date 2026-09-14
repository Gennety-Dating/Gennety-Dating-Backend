import { createHash } from "node:crypto";
import { VENUE_AGREEMENT_NONCE_LENGTH } from "@gennety/shared";

/**
 * Fingerprint of ONE venue-change agreement (§3.7b), carried by everything that
 * acts on it from outside the live board: the Stars invoice payload and the
 * wish card's "not this time" button.
 *
 * Why a fingerprint rather than a stored id: there is no agreement id column,
 * and adding one is a schema change. What there is, is the set of columns the
 * two agreement writers (`reachAgreement`, `mintExpressChange`) stamp together,
 * and every one of them is either new on each agreement or names the venue:
 *
 *   - `venueChangeProposedAt` / `venueChangeProposerId` — the session;
 *   - `venueChangeExpiresAt` — the agreement's own deadline;
 *   - `venueChangeExpressAt` — a re-mint of the same express venue;
 *   - `venueChangePlaceId` / `venueChangeName` / `venueChangeTier` — the venue
 *     and its price class.
 *
 * Two agreements can only share a fingerprint if they agree the same venue,
 * in the same session, for the same payer, at the same deadline — at which
 * point paying one IS paying the other, so treating them as equal is correct.
 */
export interface VenueAgreementFields {
  venueChangeProposedAt: Date | null;
  venueChangeProposerId: string | null;
  venueChangeExpiresAt: Date | null;
  venueChangeExpressAt: Date | null;
  venueChangePlaceId: string | null;
  venueChangeName: string | null;
  venueChangeTier: string | null;
}

export function venueAgreementNonce(row: VenueAgreementFields): string {
  const parts = [
    row.venueChangeProposedAt?.toISOString() ?? "",
    row.venueChangeProposerId ?? "",
    row.venueChangeExpiresAt?.toISOString() ?? "",
    row.venueChangeExpressAt?.toISOString() ?? "",
    row.venueChangePlaceId ?? "",
    row.venueChangeName ?? "",
    row.venueChangeTier ?? "",
  ];
  return createHash("sha256")
    .update(parts.join("\u001f"))
    .digest("hex")
    .slice(0, VENUE_AGREEMENT_NONCE_LENGTH);
}

/** The select clause that feeds {@link venueAgreementNonce}. */
export const VENUE_AGREEMENT_NONCE_SELECT = {
  venueChangeProposedAt: true,
  venueChangeProposerId: true,
  venueChangeExpiresAt: true,
  venueChangeExpressAt: true,
  venueChangePlaceId: true,
  venueChangeName: true,
  venueChangeTier: true,
} as const;

/**
 * The same columns as a compare-and-set `where` fragment: a write guarded by it
 * lands only on the exact agreement the nonce was checked against, so a new
 * agreement written between the read and the write makes the write claim
 * nothing instead of acting on the wrong one.
 */
export function venueAgreementWhere(row: VenueAgreementFields): VenueAgreementFields {
  return {
    venueChangeProposedAt: row.venueChangeProposedAt,
    venueChangeProposerId: row.venueChangeProposerId,
    venueChangeExpiresAt: row.venueChangeExpiresAt,
    venueChangeExpressAt: row.venueChangeExpressAt,
    venueChangePlaceId: row.venueChangePlaceId,
    venueChangeName: row.venueChangeName,
    venueChangeTier: row.venueChangeTier,
  };
}
