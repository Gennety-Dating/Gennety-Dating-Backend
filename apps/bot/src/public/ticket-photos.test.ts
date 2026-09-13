import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: { BOT_TOKEN: "123456:ticket-photo-signing", PUBLIC_BASE_URL: "https://api.example.test/" },
}));

const {
  TICKET_PHOTO_TTL_MS,
  ticketPhotoExpiry,
  ticketPhotoSignatureValid,
  ticketPhotoUrl,
} = await import("./ticket-photos.js");

const MATCH = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 8, 14, 18, 3, 0);

function parts(url: string): { path: string; v: string; e: number; sig: string } {
  const parsed = new URL(url);
  return {
    path: parsed.pathname,
    v: parsed.searchParams.get("v") ?? "",
    e: Number(parsed.searchParams.get("e")),
    sig: parsed.searchParams.get("sig") ?? "",
  };
}

/** A13-L16 — avatar links carry a signature, never the Mini App's initData. */
describe("ticketPhotoUrl", () => {
  it("is an absolute link to the side's photo, with no initData in it", () => {
    const url = ticketPhotoUrl(5986970093, MATCH, "partner", NOW);
    expect(url.startsWith(`https://api.example.test/v1/matches/${MATCH}/ticket/photo/partner?`)).toBe(
      true,
    );
    expect(url).not.toContain("a=");
    expect(url).not.toContain("hash");
  });

  it("verifies for exactly the viewer, match and side it was minted for", () => {
    const { v, e, sig } = parts(ticketPhotoUrl(5986970093, MATCH, "self", NOW));
    expect(ticketPhotoSignatureValid(v, MATCH, "self", e, sig, NOW)).toBe(true);
    expect(ticketPhotoSignatureValid(v, MATCH, "partner", e, sig, NOW)).toBe(false);
    expect(ticketPhotoSignatureValid("5986970094", MATCH, "self", e, sig, NOW)).toBe(false);
    expect(
      ticketPhotoSignatureValid(v, "33333333-3333-4333-8333-333333333333", "self", e, sig, NOW),
    ).toBe(false);
    expect(ticketPhotoSignatureValid(v, MATCH, "self", e + 1, sig, NOW)).toBe(false);
  });

  it("stops working once expired", () => {
    const { v, e, sig } = parts(ticketPhotoUrl(5986970093, MATCH, "self", NOW));
    expect(ticketPhotoSignatureValid(v, MATCH, "self", e, sig, e + 1)).toBe(false);
  });

  it("rejects a viewer that is not a Telegram id at all", () => {
    const { e, sig } = parts(ticketPhotoUrl(5986970093, MATCH, "self", NOW));
    expect(ticketPhotoSignatureValid("5986970093&x", MATCH, "self", e, sig, NOW)).toBe(false);
  });

  it("accepts a negative synthetic id (mobile-first accounts)", () => {
    const { v, e, sig } = parts(ticketPhotoUrl(-4200000000001, MATCH, "self", NOW));
    expect(v).toBe("-4200000000001");
    expect(ticketPhotoSignatureValid(v, MATCH, "self", e, sig, NOW)).toBe(true);
  });
});

describe("ticketPhotoExpiry", () => {
  it("lives at least a TTL, and at most two", () => {
    const at = ticketPhotoExpiry(NOW);
    expect(at - NOW).toBeGreaterThanOrEqual(TICKET_PHOTO_TTL_MS);
    expect(at - NOW).toBeLessThan(2 * TICKET_PHOTO_TTL_MS);
  });

  it("mints the same link for every 4 s poll in one window, so the <img> is not refetched", () => {
    const first = ticketPhotoUrl(5986970093, MATCH, "self", NOW);
    for (let t = 4_000; t < 60_000; t += 4_000) {
      expect(ticketPhotoUrl(5986970093, MATCH, "self", NOW + t)).toBe(first);
    }
  });
});
