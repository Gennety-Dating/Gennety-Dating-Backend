import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards for the ticket rail (LAUNCH_EVENTS_PRODUCT_SPEC.md §6–§8).
 *
 * Almost everything here is a CONCURRENCY property, and every one of them fails
 * silently: a broken capacity guard oversells a room and nothing throws, a
 * broken single-use check admits one code twice and both people walk in. So the
 * tests are written against the shape of the write (a conditional update
 * claiming zero rows) rather than against the happy path.
 */

const eventFindUnique = vi.fn();
const tierFindUnique = vi.fn();
const ticketFindUnique = vi.fn();
const ticketCreate = vi.fn();
const ticketUpdateMany = vi.fn();
const applicationFindUnique = vi.fn();
const executeRaw = vi.fn();

const tx = {
  event: { findUnique: eventFindUnique },
  eventTicketTier: { findUnique: tierFindUnique },
  eventTicket: {
    findUnique: ticketFindUnique,
    create: ticketCreate,
    updateMany: ticketUpdateMany,
  },
  waitlistApplication: { findUnique: applicationFindUnique },
  $executeRaw: executeRaw,
};

vi.mock("@gennety/db", () => ({
  prisma: {
    eventTicket: { findUnique: ticketFindUnique, updateMany: ticketUpdateMany },
    // The INTERACTIVE form — it hands the callback a `tx` and lets it return
    // early. Mocking it as the array form would make every CAS below look like
    // it passes while the real one could not short-circuit at all.
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));

const SECRET = "a".repeat(64);
vi.mock("../config.js", () => ({ env: { EVENT_QR_SECRET: "a".repeat(64) } }));

const { EVENT_QR_VERSION, signEventQr } = await import("./event-qr.js");
const {
  EVENT_QR_TTL_SECONDS,
  claimEventTicket,
  mintTicketQr,
  redeemPerk,
  revokeEventTicket,
  rotateTicketNonce,
  scanEventTicket,
} = await import("./event-ticket.js");

const NOW = new Date("2026-09-12T19:30:00.000Z");
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TIER_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN_ID = "55555555-5555-4555-8555-555555555555";
const NONCE = "nonce-one";

function code(overrides: Partial<Parameters<typeof signEventQr>[0]> = {}): string {
  return signEventQr(
    {
      v: EVENT_QR_VERSION,
      t: TICKET_ID,
      e: EVENT_ID,
      n: NONCE,
      exp: Math.floor(NOW.getTime() / 1000) + 60,
      ...overrides,
    },
    SECRET,
  );
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    eventId: EVENT_ID,
    status: "issued",
    qrNonce: NONCE,
    checkedInAt: null,
    perkRedeemedAt: null,
    tier: { title: "General" },
    user: { firstName: "Ева", age: 25, profile: { photos: ["p1"] } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  eventFindUnique.mockResolvedValue({ id: EVENT_ID, status: "upcoming" });
  tierFindUnique.mockResolvedValue({ id: TIER_ID, eventId: EVENT_ID, requiresAdmission: false });
  ticketFindUnique.mockResolvedValue(null);
  ticketCreate.mockResolvedValue({ id: TICKET_ID });
  executeRaw.mockResolvedValue(1);
});

describe("claimEventTicket", () => {
  it("claims a seat and issues a ticket", async () => {
    const result = await claimEventTicket(USER_ID, EVENT_ID, TIER_ID);
    expect(result).toEqual({ ok: true, ticketId: TICKET_ID, created: true });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(ticketCreate).toHaveBeenCalledTimes(1);
  });

  // The capacity guard. Two people race for the last seat: the conditional
  // increment updates one row and zero rows, so exactly one ticket exists.
  it("refuses when the conditional increment claims no row, and issues nothing", async () => {
    executeRaw.mockResolvedValue(0);
    const result = await claimEventTicket(USER_ID, EVENT_ID, TIER_ID);
    expect(result).toEqual({ ok: false, reason: "tier_full" });
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  // A double tap must be free. If this ever consumes a second seat, a room
  // sells out to half as many people and nothing looks wrong.
  it("is idempotent and does NOT consume a second seat", async () => {
    ticketFindUnique.mockResolvedValue({ id: TICKET_ID });
    const result = await claimEventTicket(USER_ID, EVENT_ID, TIER_ID);
    expect(result).toEqual({ ok: true, ticketId: TICKET_ID, created: false });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it("refuses an un-admitted applicant on a tier that requires admission", async () => {
    tierFindUnique.mockResolvedValue({ id: TIER_ID, eventId: EVENT_ID, requiresAdmission: true });
    applicationFindUnique.mockResolvedValue({ tier: "pending_review" });
    const result = await claimEventTicket(USER_ID, EVENT_ID, TIER_ID);
    expect(result).toEqual({ ok: false, reason: "not_admitted" });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("admits an approved applicant on the same tier", async () => {
    tierFindUnique.mockResolvedValue({ id: TIER_ID, eventId: EVENT_ID, requiresAdmission: true });
    applicationFindUnique.mockResolvedValue({ tier: "approved" });
    const result = await claimEventTicket(USER_ID, EVENT_ID, TIER_ID);
    expect(result).toMatchObject({ ok: true });
  });

  // An unpublished event handing out working door codes is how a party gets
  // gate-crashed by whoever found the link early.
  it.each(["draft", "concluded", "cancelled"])("refuses a %s event", async (status) => {
    eventFindUnique.mockResolvedValue({ id: EVENT_ID, status });
    const result = await claimEventTicket(USER_ID, EVENT_ID, TIER_ID);
    expect(result).toEqual({ ok: false, reason: "event_closed" });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("refuses a tier belonging to a different event", async () => {
    tierFindUnique.mockResolvedValue({ id: TIER_ID, eventId: "other", requiresAdmission: false });
    const result = await claimEventTicket(USER_ID, EVENT_ID, TIER_ID);
    expect(result).toEqual({ ok: false, reason: "tier_not_found" });
  });
});

describe("scanEventTicket", () => {
  it("admits a valid code and records who opened the door", async () => {
    ticketFindUnique.mockResolvedValue(ticketRow());
    ticketUpdateMany.mockResolvedValue({ count: 1 });

    const verdict = await scanEventTicket(code(), EVENT_ID, TOKEN_ID, NOW);

    expect(verdict).toMatchObject({ ok: true, outcome: "admitted", ticketId: TICKET_ID });
    expect(ticketUpdateMany).toHaveBeenCalledWith({
      where: { id: TICKET_ID, checkedInAt: null },
      data: { status: "checked_in", checkedInAt: NOW, checkedInByTokenId: TOKEN_ID },
    });
  });

  // A forged code must not become a database lookup — otherwise the door is a
  // free oracle for whether a ticket id exists.
  it("rejects a forged signature without touching the database", async () => {
    const forged = signEventQr(
      { v: EVENT_QR_VERSION, t: TICKET_ID, e: EVENT_ID, n: NONCE, exp: 9_999_999_999 },
      "b".repeat(64),
    );
    const verdict = await scanEventTicket(forged, EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toEqual({ ok: false, outcome: "bad_signature" });
    expect(ticketFindUnique).not.toHaveBeenCalled();
  });

  it("rejects another event's genuine code by shape, without a lookup", async () => {
    const other = code({ e: "99999999-9999-4999-8999-999999999999" });
    const verdict = await scanEventTicket(other, EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toEqual({ ok: false, outcome: "wrong_event" });
    expect(ticketFindUnique).not.toHaveBeenCalled();
  });

  it("reports an expired code as expired, not as forged", async () => {
    const stale = code({ exp: Math.floor(NOW.getTime() / 1000) - 1 });
    const verdict = await scanEventTicket(stale, EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toEqual({ ok: false, outcome: "expired" });
  });

  // A rotated nonce is what "my code leaked" actually does: every code minted
  // before the rotation stops working, and says so distinctly.
  it("refuses a code minted before the nonce rotated", async () => {
    ticketFindUnique.mockResolvedValue(ticketRow({ qrNonce: "nonce-two" }));
    const verdict = await scanEventTicket(code(), EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toMatchObject({ ok: false, outcome: "stale_code" });
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a revoked ticket", async () => {
    ticketFindUnique.mockResolvedValue(ticketRow({ status: "revoked" }));
    const verdict = await scanEventTicket(code(), EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toMatchObject({ ok: false, outcome: "revoked" });
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });

  it("names who is already inside rather than just refusing", async () => {
    const checkedInAt = new Date("2026-09-12T19:00:00.000Z");
    ticketFindUnique.mockResolvedValue(ticketRow({ checkedInAt }));
    const verdict = await scanEventTicket(code(), EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toMatchObject({
      ok: false,
      outcome: "already_used",
      attendee: { firstName: "Ева", age: 25 },
      checkedInAt: checkedInAt.toISOString(),
    });
  });

  // The single-use guarantee is the DATABASE's, not the signature's. Two doors
  // scanning one screenshot in the same second: one admission, one refusal.
  it("refuses when the check-in CAS loses the race", async () => {
    ticketFindUnique.mockResolvedValue(ticketRow());
    ticketUpdateMany.mockResolvedValue({ count: 0 });
    const verdict = await scanEventTicket(code(), EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toMatchObject({ ok: false, outcome: "already_used" });
  });

  it("treats a ticket from another event as unknown", async () => {
    ticketFindUnique.mockResolvedValue(ticketRow({ eventId: "other" }));
    const verdict = await scanEventTicket(code(), EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toEqual({ ok: false, outcome: "unknown_ticket" });
  });

  it("carries the attendee photo so staff can compare a face", async () => {
    ticketFindUnique.mockResolvedValue(ticketRow());
    ticketUpdateMany.mockResolvedValue({ count: 1 });
    const verdict = await scanEventTicket(code(), EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toMatchObject({ attendee: { photo: "p1" } });
  });
});

describe("mintTicketQr", () => {
  it("mints a code the door accepts, expiring in EVENT_QR_TTL_SECONDS", async () => {
    ticketFindUnique.mockResolvedValue({
      id: TICKET_ID,
      eventId: EVENT_ID,
      qrNonce: NONCE,
      status: "issued",
    });
    const minted = await mintTicketQr(USER_ID, EVENT_ID, NOW);
    expect(minted?.expiresAt).toBe(
      new Date(NOW.getTime() + EVENT_QR_TTL_SECONDS * 1000).toISOString(),
    );

    ticketFindUnique.mockResolvedValue(ticketRow());
    ticketUpdateMany.mockResolvedValue({ count: 1 });
    const verdict = await scanEventTicket(minted!.code, EVENT_ID, TOKEN_ID, NOW);
    expect(verdict).toMatchObject({ ok: true, outcome: "admitted" });
  });

  it("mints nothing for a revoked ticket", async () => {
    ticketFindUnique.mockResolvedValue({
      id: TICKET_ID,
      eventId: EVENT_ID,
      qrNonce: NONCE,
      status: "revoked",
    });
    expect(await mintTicketQr(USER_ID, EVENT_ID, NOW)).toBeNull();
  });

  // "Not yours" and "does not exist" must answer identically, or the endpoint
  // becomes a probe for ticket ids.
  it("mints nothing when the caller holds no ticket", async () => {
    ticketFindUnique.mockResolvedValue(null);
    expect(await mintTicketQr(USER_ID, EVENT_ID, NOW)).toBeNull();
  });
});

describe("rotateTicketNonce", () => {
  it("rotates only a ticket that is not revoked", async () => {
    ticketUpdateMany.mockResolvedValue({ count: 1 });
    expect(await rotateTicketNonce(USER_ID, EVENT_ID)).toBe(true);
    expect(ticketUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: EVENT_ID, userId: USER_ID, status: { not: "revoked" } },
      }),
    );
  });

  it("reports failure when nothing rotated", async () => {
    ticketUpdateMany.mockResolvedValue({ count: 0 });
    expect(await rotateTicketNonce(USER_ID, EVENT_ID)).toBe(false);
  });
});

describe("redeemPerk", () => {
  it("pours one drink", async () => {
    ticketFindUnique.mockResolvedValue({
      id: TICKET_ID,
      eventId: EVENT_ID,
      checkedInAt: NOW,
      perkRedeemedAt: null,
    });
    ticketUpdateMany.mockResolvedValue({ count: 1 });
    expect(await redeemPerk(TICKET_ID, EVENT_ID, NOW)).toEqual({ ok: true });
  });

  // A perk before entry is a drink for somebody who is not at the party.
  it("refuses before the guest has entered", async () => {
    ticketFindUnique.mockResolvedValue({
      id: TICKET_ID,
      eventId: EVENT_ID,
      checkedInAt: null,
      perkRedeemedAt: null,
    });
    expect(await redeemPerk(TICKET_ID, EVENT_ID, NOW)).toEqual({
      ok: false,
      reason: "not_checked_in",
    });
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });

  // Two bar phones, one cocktail.
  it("refuses when the perk CAS loses the race", async () => {
    ticketFindUnique.mockResolvedValue({
      id: TICKET_ID,
      eventId: EVENT_ID,
      checkedInAt: NOW,
      perkRedeemedAt: null,
    });
    ticketUpdateMany.mockResolvedValue({ count: 0 });
    expect(await redeemPerk(TICKET_ID, EVENT_ID, NOW)).toEqual({
      ok: false,
      reason: "already_redeemed",
    });
  });

  it("refuses a ticket from another event", async () => {
    ticketFindUnique.mockResolvedValue({
      id: TICKET_ID,
      eventId: "other",
      checkedInAt: NOW,
      perkRedeemedAt: null,
    });
    expect(await redeemPerk(TICKET_ID, EVENT_ID, NOW)).toEqual({
      ok: false,
      reason: "unknown_ticket",
    });
  });
});

describe("revokeEventTicket", () => {
  it("revokes the ticket and releases its seat", async () => {
    ticketFindUnique.mockResolvedValue({ id: TICKET_ID, tierId: TIER_ID, status: "issued" });
    ticketUpdateMany.mockResolvedValue({ count: 1 });
    expect(await revokeEventTicket(TICKET_ID)).toBe(true);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  // Revoking twice must not release two seats — that is how a counter drifts
  // below the truth and quietly inflates capacity for everyone after it.
  it("does not release a seat twice", async () => {
    ticketFindUnique.mockResolvedValue({ id: TICKET_ID, tierId: TIER_ID, status: "revoked" });
    expect(await revokeEventTicket(TICKET_ID)).toBe(false);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("releases nothing when the revoke CAS loses", async () => {
    ticketFindUnique.mockResolvedValue({ id: TICKET_ID, tierId: TIER_ID, status: "issued" });
    ticketUpdateMany.mockResolvedValue({ count: 0 });
    expect(await revokeEventTicket(TICKET_ID)).toBe(false);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
