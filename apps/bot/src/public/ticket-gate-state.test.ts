/**
 * `SerializedMatch.ticketGate` — which §3.5b screen (if any) a side owes.
 *
 * Worth its own suite because the obvious implementation is wrong in a way
 * that is invisible until the feature is switched on: `Match.ticketStatus`
 * DEFAULTS to `"pending"` on every row the table has ever held, so a match
 * created years before the gate existed is indistinguishable from one whose
 * gate is genuinely open. `ticketExpiresAt` is the column `sendTicketOffer`
 * actually stamps, and the one both completion and expiry clear.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = { TICKET_FEATURE_ENABLED: true };
vi.mock("../config.js", () => ({ env }));

const { ticketGateFor } = await import("./ticket-gate-state.js");
type Columns = Parameters<typeof ticketGateFor>[0];

const armed: Columns = {
  ticketStatus: "pending",
  ticketExpiresAt: new Date(Date.now() + 86_400_000),
  paidForPartnerByA: false,
  paidForPartnerByB: false,
  partnerPaidSeenAt: null,
};

beforeEach(() => {
  env.TICKET_FEATURE_ENABLED = true;
});

describe("ticketGateFor", () => {
  it("is `open` while the gate blocks the Calendar", () => {
    expect(ticketGateFor(armed, "A")).toBe("open");
    expect(ticketGateFor({ ...armed, ticketStatus: "partial" }, "B")).toBe("open");
  });

  // The trap this function exists for.
  it("is `none` for a never-armed row, despite ticketStatus reading 'pending'", () => {
    expect(ticketGateFor({ ...armed, ticketExpiresAt: null }, "A")).toBe("none");
  });

  it("is `none` with the feature off, whatever the columns say", () => {
    env.TICKET_FEATURE_ENABLED = false;
    expect(ticketGateFor(armed, "A")).toBe("none");
  });

  it("is `none` once the window lapsed and scheduling opened for free", () => {
    for (const ticketStatus of ["expired", "refunded"]) {
      expect(ticketGateFor({ ...armed, ticketStatus, ticketExpiresAt: null }, "A")).toBe("none");
    }
  });

  describe("the cover reveal", () => {
    const covered: Columns = {
      ticketStatus: "completed",
      ticketExpiresAt: null,
      // B paid for A, so A is the covered side.
      paidForPartnerByA: false,
      paidForPartnerByB: true,
      partnerPaidSeenAt: null,
    };

    // The server holds her Calendar back until she opens this, so routing her
    // straight to planning strands her on a screen with nothing on it.
    it("is `reveal` for the covered side until they have seen it", () => {
      expect(ticketGateFor(covered, "A")).toBe("reveal");
    });

    it("is `none` for the payer — the surprise is not theirs to be shown", () => {
      expect(ticketGateFor(covered, "B")).toBe("none");
    });

    it("is `none` once the receipt is stamped", () => {
      expect(ticketGateFor({ ...covered, partnerPaidSeenAt: new Date() }, "A")).toBe("none");
    });

    it("is `none` for an ordinary completed gate where nobody covered anybody", () => {
      expect(ticketGateFor({ ...covered, paidForPartnerByB: false }, "A")).toBe("none");
    });
  });
});
