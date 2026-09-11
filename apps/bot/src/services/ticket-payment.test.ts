import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    TICKET_STARS_ENABLED: false,
    DEMO_MODE_ENABLED: false,
    TICKET_BUNDLE_STARS: { 1: 425, 3: 1020, 6: 1650 },
  },
}));

const { amountForScope, gateStarsForScope, ticketPurchaseRail, ticketsForScope } = await import(
  "./ticket-payment.js"
);

const STARS_ON = { TICKET_STARS_ENABLED: true, DEMO_MODE_ENABLED: false };
const STARS_OFF = { TICKET_STARS_ENABLED: false, DEMO_MODE_ENABLED: false };
const DEMO = { TICKET_STARS_ENABLED: false, DEMO_MODE_ENABLED: true };

describe("ticketPurchaseRail", () => {
  it("is Stars whenever Stars is on, in every runtime", () => {
    for (const runtime of ["production", "development", "test", undefined]) {
      expect(ticketPurchaseRail(STARS_ON, runtime)).toBe("stars");
    }
  });

  it("settles without a charge in the demo and in local development", () => {
    expect(ticketPurchaseRail(DEMO, "production")).toBe("no-charge");
    expect(ticketPurchaseRail(STARS_OFF, "development")).toBe("no-charge");
    expect(ticketPurchaseRail(STARS_OFF, "test")).toBe("no-charge");
  });

  it("never opens the no-charge settle in production, whatever the .env forgot", () => {
    // The removed mock rail defaulted ON when a variable was missing. The
    // runtime decides now, so a production process with Stars off can sell
    // nothing at all — and `assertPaymentTrustConfiguration` refuses to boot it.
    expect(ticketPurchaseRail(STARS_OFF, "production")).toBe("none");
    // An empty NODE_ENV — `undefined` would hand the default parameter the
    // test runner's own "test" and prove nothing.
    expect(ticketPurchaseRail(STARS_OFF, "")).toBe("none");
  });
});

describe("gate pricing", () => {
  it("counts one ticket for self/partner and two for both", () => {
    expect(ticketsForScope("self")).toBe(1);
    expect(ticketsForScope("partner")).toBe(1);
    expect(ticketsForScope("both")).toBe(2);
    expect(amountForScope("both", 849)).toBe(1698);
  });

  it("prices the gate in Stars off the 1-ticket bundle, so gate and store agree", () => {
    expect(gateStarsForScope("self")).toBe(425);
    expect(gateStarsForScope("partner")).toBe(425);
    expect(gateStarsForScope("both")).toBe(850);
  });
});
