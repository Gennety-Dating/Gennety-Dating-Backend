import { describe, expect, it } from "vitest";
import type { TicketState } from "../api.js";
import {
  deriveScreen,
  deriveOfferButtons,
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
    bothPaid: false,
    expiresAt: null,
    paymentMode: "mock",
    ...overrides,
  };
}

describe("deriveScreen", () => {
  it("offer when nobody relevant has paid", () => {
    expect(deriveScreen(state())).toBe("offer");
  });
  it("waiting when I paid but partner hasn't", () => {
    expect(deriveScreen(state({ iPaid: true, ticketStatus: "partial" }))).toBe("waiting");
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

describe("deriveOfferButtons", () => {
  it("male gets pay-for-both (primary, doubled) + pay-self", () => {
    const btns = deriveOfferButtons(state({ myGender: "male" }));
    expect(btns).toHaveLength(2);
    expect(btns[0]).toEqual({ scope: "both", amountCents: 1398, primary: true });
    expect(btns[1]).toEqual({ scope: "self", amountCents: 699, primary: false });
  });
  it("female gets a single self-pay button", () => {
    const btns = deriveOfferButtons(state({ myGender: "female" }));
    expect(btns).toEqual([{ scope: "self", amountCents: 699, primary: true }]);
  });
  it("unknown gender never offers pay-for-both", () => {
    const btns = deriveOfferButtons(state({ myGender: null }));
    expect(btns).toHaveLength(1);
    expect(btns[0]!.scope).toBe("self");
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
