import { describe, expect, it } from "vitest";
import type { TicketState } from "../api.js";
import {
  deriveScreen,
  deriveOfferButtons,
  deriveCoverPartnerButtons,
  formatUsd,
  formatCountdown,
  msUntil,
} from "./ticket-state.js";

function state(overrides: Partial<TicketState> = {}): TicketState {
  return {
    ticketStatus: "pending",
    priceCents: 699,
    myGender: "male",
    mySide: "A",
    iPaid: false,
    partnerPaid: false,
    partnerName: "Sam",
    partnerPaidForMe: false,
    iCoveredPartner: false,
    bothPaid: false,
    expiresAt: null,
    paymentMode: "mock",
    myBalance: 0,
    selfDiscountPct: 0,
    selfPriceCents: 699,
    ...overrides,
  };
}

describe("deriveScreen", () => {
  it("offer when nobody relevant has paid", () => {
    expect(deriveScreen(state())).toBe("offer");
  });
  it("waiting when a female paid but partner hasn't", () => {
    expect(deriveScreen(state({ myGender: "female", iPaid: true, ticketStatus: "partial" }))).toBe("waiting");
  });
  it("cover-partner when a male paid his own but partner hasn't", () => {
    expect(deriveScreen(state({ myGender: "male", iPaid: true, ticketStatus: "partial" }))).toBe("cover-partner");
  });
  it("success when both paid and I acted", () => {
    expect(deriveScreen(state({ iPaid: true, partnerPaid: true, bothPaid: true, ticketStatus: "completed" }))).toBe(
      "success",
    );
  });
  it("partner-paid takes precedence over success when partner covered me", () => {
    expect(
      deriveScreen(state({ iPaid: true, partnerPaid: true, bothPaid: true, partnerPaidForMe: true })),
    ).toBe("partner-paid");
  });
  it("closed on refund/expiry", () => {
    expect(deriveScreen(state({ ticketStatus: "refunded" }))).toBe("closed");
    expect(deriveScreen(state({ ticketStatus: "expired" }))).toBe("closed");
  });
});

describe("deriveOfferButtons (balance 0 = money path)", () => {
  it("male gets pay-for-both (primary, doubled) + pay-self", () => {
    const btns = deriveOfferButtons(state({ myGender: "male", myBalance: 0 }));
    expect(btns).toHaveLength(2);
    expect(btns[0]).toEqual({ action: "pay", scope: "both", amountCents: 1398, ticketCost: 0, primary: true });
    expect(btns[1]).toEqual({ action: "pay", scope: "self", amountCents: 699, ticketCost: 0, primary: false });
  });
  it("female gets a single self-pay button", () => {
    const btns = deriveOfferButtons(state({ myGender: "female", myBalance: 0 }));
    expect(btns).toEqual([{ action: "pay", scope: "self", amountCents: 699, ticketCost: 0, primary: true }]);
  });
  it("unknown gender never offers pay-for-both", () => {
    const btns = deriveOfferButtons(state({ myGender: null, myBalance: 0 }));
    expect(btns).toHaveLength(1);
    expect(btns[0]!.scope).toBe("self");
  });
});

describe("deriveOfferButtons (famine single-ticket discount)", () => {
  it("female self-pay uses the discounted selfPriceCents", () => {
    const btns = deriveOfferButtons(
      state({ myGender: "female", myBalance: 0, selfDiscountPct: 77, selfPriceCents: 161 }),
    );
    expect(btns).toEqual([{ action: "pay", scope: "self", amountCents: 161, ticketCost: 0, primary: true }]);
  });
  it("male: only the self button is discounted; pay-for-both stays full", () => {
    const btns = deriveOfferButtons(
      state({ myGender: "male", myBalance: 0, selfDiscountPct: 77, selfPriceCents: 161 }),
    );
    expect(btns[0]).toEqual({ action: "pay", scope: "both", amountCents: 1398, ticketCost: 0, primary: true });
    expect(btns[1]).toEqual({ action: "pay", scope: "self", amountCents: 161, ticketCost: 0, primary: false });
  });
  it("wallet 'use' paths ignore the discount (using a ticket is free)", () => {
    const btns = deriveOfferButtons(
      state({ myGender: "female", myBalance: 1, selfDiscountPct: 77, selfPriceCents: 161 }),
    );
    expect(btns).toEqual([{ action: "use", scope: "self", amountCents: 0, ticketCost: 1, primary: true }]);
  });
});

describe("deriveOfferButtons (balance-aware)", () => {
  it("female with a ticket uses it instead of paying", () => {
    const btns = deriveOfferButtons(state({ myGender: "female", myBalance: 1 }));
    expect(btns).toEqual([{ action: "use", scope: "self", amountCents: 0, ticketCost: 1, primary: true }]);
  });
  it("male with 2 tickets can use both (primary) or just self", () => {
    const btns = deriveOfferButtons(state({ myGender: "male", myBalance: 2 }));
    expect(btns[0]).toEqual({ action: "use", scope: "both", amountCents: 0, ticketCost: 2, primary: true });
    expect(btns[1]).toEqual({ action: "use", scope: "self", amountCents: 0, ticketCost: 1, primary: false });
  });
  it("male with 1 ticket uses it for self, covers both via ticket + single price", () => {
    const btns = deriveOfferButtons(state({ myGender: "male", myBalance: 1 }));
    expect(btns[0]).toEqual({ action: "use", scope: "self", amountCents: 0, ticketCost: 1, primary: true });
    // Cover-both shortcut: 🎫 on his own slot + one ticket's price for the
    // partner — never the doubled $13.98 when he already holds a ticket.
    expect(btns[1]).toEqual({
      action: "use-self-pay-partner",
      scope: "both",
      amountCents: 699,
      ticketCost: 1,
      primary: false,
    });
  });
});

describe("deriveCoverPartnerButtons", () => {
  it("offers a ticket (primary) or money when balance remains", () => {
    const btns = deriveCoverPartnerButtons(state({ myGender: "male", iPaid: true, myBalance: 1 }));
    expect(btns[0]).toEqual({ action: "use", scope: "partner", amountCents: 0, ticketCost: 1, primary: true });
    expect(btns[1]).toEqual({ action: "pay", scope: "partner", amountCents: 699, ticketCost: 0, primary: false });
  });
  it("offers only money when no tickets left", () => {
    const btns = deriveCoverPartnerButtons(state({ myGender: "male", iPaid: true, myBalance: 0 }));
    expect(btns).toEqual([{ action: "pay", scope: "partner", amountCents: 699, ticketCost: 0, primary: true }]);
  });
});

describe("formatting helpers", () => {
  it("formats cents as USD", () => {
    expect(formatUsd(699)).toBe("$6.99");
    expect(formatUsd(1398)).toBe("$13.98");
  });
  it("formats countdown spans", () => {
    expect(formatCountdown(0)).toBe("0m");
    expect(formatCountdown(90 * 60 * 1000)).toBe("1h 30m");
    expect(formatCountdown(5 * 60 * 1000)).toBe("5m");
    expect(formatCountdown(30 * 1000)).toBe("<1m");
  });
  it("msUntil clamps to zero in the past", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(msUntil(past)).toBe(0);
    expect(msUntil(null)).toBe(0);
  });
});
