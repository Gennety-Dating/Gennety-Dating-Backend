import { describe, expect, it } from "vitest";
// `?raw` for the board: it is a Mini App entry that runs on import.
import BOARD from "./venue-change.ts?raw";
import { CalendarApiError, parseVenueInvoice } from "./api.js";

/**
 * A13-H16. The Premium express swap is free, so the server settles it and
 * answers `{ ok, settled: true, free: true }` with NO link. The client did
 * `String(body.link)` and opened an invoice for "undefined".
 */
describe("parseVenueInvoice", () => {
  it("reports a free, already-settled change as settled — with no link to open", () => {
    expect(parseVenueInvoice({ ok: true, settled: true, free: true })).toEqual({ settled: true });
  });

  it("returns the link and price of a paid change", () => {
    expect(parseVenueInvoice({ ok: true, link: "https://t.me/$x", stars: 150 })).toEqual({
      settled: false,
      link: "https://t.me/$x",
      stars: 150,
    });
  });

  it("refuses a response that is neither settled nor payable", () => {
    expect(() => parseVenueInvoice({ ok: true })).toThrow(CalendarApiError);
    expect(() => parseVenueInvoice({ ok: true, link: "" })).toThrow(CalendarApiError);
  });
});

describe("the board's express and pay taps", () => {
  it("go straight to the settle wait when the change is already settled", () => {
    const express = BOARD.slice(BOARD.indexOf("async function startExpress("));
    const body = express.slice(0, express.indexOf("\n}\n"));
    expect(body).toContain("if (invoice.settled) finalizeSettled();");
  });

  it("check the in-flight flag before minting anything (A13-M28)", () => {
    for (const name of ["async function payAgreed(", "async function startExpress("]) {
      const fn = BOARD.slice(BOARD.indexOf(name));
      const body = fn.slice(0, fn.indexOf("\n}\n"));
      expect(body, name).toContain("if (previewMode || busy) return;");
      expect(body.indexOf("busy = true"), name).toBeLessThan(body.indexOf("await "));
    }
  });
});
