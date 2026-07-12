import { describe, it, expect } from "vitest";
import {
  STORE_INVOICE_PREFIX,
  buildStoreInvoicePayload,
  parseStoreInvoicePayload,
  buildGateInvoicePayload,
  parseGateInvoicePayload,
  buildVenueInvoicePayload,
  parseVenueInvoicePayload,
} from "./stars.js";

const UUID = "22222222-2222-4222-8222-222222222222";

describe("store invoice payload", () => {
  it("builds a payload for a bundle size", () => {
    expect(buildStoreInvoicePayload(3)).toBe(`${STORE_INVOICE_PREFIX}3`);
  });

  it("round-trips build → parse", () => {
    for (const count of [1, 3, 6]) {
      expect(parseStoreInvoicePayload(buildStoreInvoicePayload(count))).toBe(count);
    }
  });

  it("returns null for non-store or malformed payloads", () => {
    expect(parseStoreInvoicePayload("")).toBeNull();
    expect(parseStoreInvoicePayload(null)).toBeNull();
    expect(parseStoreInvoicePayload(undefined)).toBeNull();
    expect(parseStoreInvoicePayload("ref_123")).toBeNull();
    expect(parseStoreInvoicePayload("store:")).toBeNull();
    expect(parseStoreInvoicePayload("store:0")).toBeNull();
    expect(parseStoreInvoicePayload("store:-3")).toBeNull();
    expect(parseStoreInvoicePayload("store:abc")).toBeNull();
    expect(parseStoreInvoicePayload("store:3.5")).toBeNull();
  });
});

describe("gate invoice payload", () => {
  it("builds a payload for a match + scope", () => {
    expect(buildGateInvoicePayload(UUID, "both")).toBe(`gate:${UUID}:both`);
  });

  it("round-trips build → parse for every scope", () => {
    for (const scope of ["self", "both", "partner"] as const) {
      expect(parseGateInvoicePayload(buildGateInvoicePayload(UUID, scope))).toEqual({
        matchId: UUID,
        scope,
      });
    }
  });

  it("returns null for non-gate, bad-UUID, or unknown-scope payloads", () => {
    expect(parseGateInvoicePayload("")).toBeNull();
    expect(parseGateInvoicePayload(null)).toBeNull();
    expect(parseGateInvoicePayload(undefined)).toBeNull();
    expect(parseGateInvoicePayload(`store:${UUID}:self`)).toBeNull();
    expect(parseGateInvoicePayload("gate:")).toBeNull();
    expect(parseGateInvoicePayload(`gate:${UUID}`)).toBeNull(); // no scope
    expect(parseGateInvoicePayload(`gate:${UUID}:free`)).toBeNull(); // bad scope
    expect(parseGateInvoicePayload("gate:not-a-uuid:self")).toBeNull();
  });

  it("does not cross-parse with the store helper", () => {
    expect(parseStoreInvoicePayload(buildGateInvoicePayload(UUID, "self"))).toBeNull();
    expect(parseGateInvoicePayload(buildStoreInvoicePayload(3))).toBeNull();
  });
});

describe("venue-change invoice payload", () => {
  it("builds a payload for a match + mode", () => {
    expect(buildVenueInvoicePayload(UUID, "agreed")).toBe(`venue:${UUID}:agreed`);
  });

  it("round-trips build → parse for both modes", () => {
    for (const mode of ["agreed", "express"] as const) {
      expect(parseVenueInvoicePayload(buildVenueInvoicePayload(UUID, mode))).toEqual({
        matchId: UUID,
        mode,
      });
    }
  });

  it("returns null for non-venue, bad-UUID, or unknown-mode payloads", () => {
    expect(parseVenueInvoicePayload("")).toBeNull();
    expect(parseVenueInvoicePayload(null)).toBeNull();
    expect(parseVenueInvoicePayload(undefined)).toBeNull();
    expect(parseVenueInvoicePayload(`gate:${UUID}:self`)).toBeNull();
    expect(parseVenueInvoicePayload("venue:")).toBeNull();
    expect(parseVenueInvoicePayload(`venue:${UUID}`)).toBeNull(); // no mode
    expect(parseVenueInvoicePayload(`venue:${UUID}:free`)).toBeNull(); // bad mode
    expect(parseVenueInvoicePayload("venue:not-a-uuid:agreed")).toBeNull();
  });

  it("does not cross-parse with the store/gate helpers", () => {
    expect(parseStoreInvoicePayload(buildVenueInvoicePayload(UUID, "agreed"))).toBeNull();
    expect(parseGateInvoicePayload(buildVenueInvoicePayload(UUID, "agreed"))).toBeNull();
    expect(parseVenueInvoicePayload(buildGateInvoicePayload(UUID, "self"))).toBeNull();
  });
});
