import { describe, expect, it } from "vitest";
// `?raw`: `premium.ts` runs on import (it boots the page), so whether the
// screen actually USES the rule is only checkable as source text — the same
// idiom `venue-photo-width.test.ts` uses for its own entry module.
import SRC from "./premium.ts?raw";
import { invoiceOutcomeFor, premiumScreenFor } from "./premium-load";

/**
 * A13-H15. A failed state request used to render the sales screen, and the
 * sales screen's button mints a RECURRING subscription — so a subscriber on a
 * bad connection could buy a second one that adds nothing and renews monthly.
 */
describe("premiumScreenFor", () => {
  it("never offers a subscription it could not check", () => {
    expect(premiumScreenFor({ ok: false })).toBe("error");
  });

  it("draws the active plate or the offer only from a real answer", () => {
    expect(premiumScreenFor({ ok: true, active: true })).toBe("active");
    expect(premiumScreenFor({ ok: true, active: false })).toBe("offer");
  });

  it("is what the page's load actually calls, with no placeholder offer left", () => {
    expect(SRC).toContain("premiumScreenFor(");
    // The removed fallback was `renderOffer({ ok: false, … })` — an offer built
    // from a literal because the server had said nothing.
    expect(SRC).not.toMatch(/renderOffer\(\{/);
  });
});

describe("invoiceOutcomeFor", () => {
  it("treats the server's duplicate-subscription refusal as a stale screen", () => {
    expect(invoiceOutcomeFor(409, { error: "premium-already-active" })).toEqual({
      kind: "already-active",
    });
  });

  it("opens a link only when there is one", () => {
    expect(invoiceOutcomeFor(200, { ok: true, link: "https://t.me/$inv" })).toEqual({
      kind: "link",
      link: "https://t.me/$inv",
    });
    expect(invoiceOutcomeFor(200, { ok: true })).toEqual({ kind: "failed" });
    expect(invoiceOutcomeFor(200, { link: "" })).toEqual({ kind: "failed" });
    expect(invoiceOutcomeFor(200, null)).toEqual({ kind: "failed" });
  });

  it("reports every other refusal as a failure, including other 409s", () => {
    expect(invoiceOutcomeFor(409, { error: "wrong-state" })).toEqual({ kind: "failed" });
    expect(invoiceOutcomeFor(502, { error: "invoice-failed" })).toEqual({ kind: "failed" });
    expect(invoiceOutcomeFor(401, null)).toEqual({ kind: "failed" });
  });
});
