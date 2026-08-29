/**
 * The post-event loop's verdict logic (LAUNCH_EVENTS §11).
 *
 * Four properties carry this file, and none of them is visible from a happy
 * path:
 *
 *  1. **A single thumb reveals nothing**, and a `false` is indistinguishable
 *     from silence — the §3.4 blind rule, carried past the party.
 *  2. **The mutual signal fires exactly once**, and specifically on the SECOND
 *     answer. A read-then-write would lose it entirely when two people answer
 *     at the same instant, which is the likeliest moment for them to.
 *  3. **The thumbs do not open during the party.** The whole reason the delay
 *     exists is that someone rating people they are standing next to is a leak
 *     no server-side rule can undo.
 *  4. **Feedback is never a hostage gate**, and answering it can never cost
 *     someone a discount they already hold.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const eventFindUnique = vi.fn();
const ticketFindUnique = vi.fn();
const pairingFindMany = vi.fn();
const pairingFindUnique = vi.fn();
const pairingUpdateMany = vi.fn();
const feedbackFindUnique = vi.fn();
const feedbackUpsert = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    event: { findUnique: (...a: unknown[]) => eventFindUnique(...a) },
    eventTicket: { findUnique: (...a: unknown[]) => ticketFindUnique(...a) },
    eventRoundPairing: {
      findMany: (...a: unknown[]) => pairingFindMany(...a),
      findUnique: (...a: unknown[]) => pairingFindUnique(...a),
      updateMany: (...a: unknown[]) => pairingUpdateMany(...a),
    },
    eventFeedback: {
      findUnique: (...a: unknown[]) => feedbackFindUnique(...a),
      upsert: (...a: unknown[]) => feedbackUpsert(...a),
    },
    user: { findUnique: vi.fn() },
  },
}));

const loadBlockedPairKeys = vi.fn();
vi.mock("./user-block.js", () => ({
  loadBlockedPairKeys: (...a: unknown[]) => loadBlockedPairKeys(...a),
}));

const getActiveDiscount = vi.fn();
const grantEventFeedbackDiscount = vi.fn();
vi.mock("./ticket-discount.js", () => ({
  getActiveDiscount: (...a: unknown[]) => getActiveDiscount(...a),
  grantEventFeedbackDiscount: (...a: unknown[]) => grantEventFeedbackDiscount(...a),
}));

const notifyFounderEventSafetyFlag = vi.fn();
vi.mock("./founder-notify.js", () => ({
  notifyFounderEventSafetyFlag: (...a: unknown[]) => notifyFounderEventSafetyFlag(...a),
}));

vi.mock("./push.js", () => ({ sendPushToUser: vi.fn() }));
vi.mock("./main-bot-api.js", () => ({ getMainBotApi: () => null }));
vi.mock("./mini-app-url.js", () => ({ buildMiniAppUrl: () => "https://example.test/event.html" }));

const {
  getEventRecap,
  recordThumb,
  submitEventFeedback,
  THUMBS_OPEN_DELAY_MS,
} = await import("./event-recap.js");

const VIEWER = "11111111-1111-4111-8111-111111111111";
const PARTNER = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const PAIRING_ID = "44444444-4444-4444-8444-444444444444";

const ENDED_AT = new Date("2026-09-12T21:00:00.000Z");
/** Comfortably past `endsAt + 2h`. */
const AFTER = new Date(ENDED_AT.getTime() + THUMBS_OPEN_DELAY_MS + 60_000);
/** Inside the party, or the two hours right after it. */
const DURING = new Date(ENDED_AT.getTime() + 60_000);

function pairing(overrides: Record<string, unknown> = {}) {
  return {
    id: PAIRING_ID,
    eventId: EVENT_ID,
    userAId: VIEWER,
    userBId: PARTNER,
    thumbsA: null,
    thumbsB: null,
    userA: { firstName: "Ева" },
    userB: { firstName: "Артём" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  eventFindUnique.mockResolvedValue({ id: EVENT_ID, title: "Launch", endsAt: ENDED_AT });
  ticketFindUnique.mockResolvedValue({ checkedInAt: ENDED_AT });
  pairingFindMany.mockResolvedValue([]);
  pairingFindUnique.mockResolvedValue(pairing());
  pairingUpdateMany.mockResolvedValue({ count: 1 });
  feedbackFindUnique.mockResolvedValue(null);
  feedbackUpsert.mockResolvedValue({});
  loadBlockedPairKeys.mockResolvedValue(new Set<string>());
  getActiveDiscount.mockResolvedValue(null);
  grantEventFeedbackDiscount.mockResolvedValue({ granted: false });
});

describe("getEventRecap", () => {
  it("is refused to someone who never came through the door", async () => {
    ticketFindUnique.mockResolvedValue({ checkedInAt: null });
    const res = await getEventRecap(VIEWER, EVENT_ID, AFTER);
    expect(res).toEqual({ ok: false, reason: "not_attended" });
    // And it does not go looking for pairings for them either.
    expect(pairingFindMany).not.toHaveBeenCalled();
  });

  it("reports the thumbs closed until two hours after the event ends", async () => {
    const res = await getEventRecap(VIEWER, EVENT_ID, DURING);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.open).toBe(false);
    expect(res.state.opensAt).toBe(
      new Date(ENDED_AT.getTime() + THUMBS_OPEN_DELAY_MS).toISOString(),
    );
  });

  it("lists only pairings BOTH sides confirmed finding each other", async () => {
    await getEventRecap(VIEWER, EVENT_ID, AFTER);
    const where = pairingFindMany.mock.calls[0]?.[0]?.where;
    expect(where.metConfirmedA).toEqual({ not: null });
    expect(where.metConfirmedB).toEqual({ not: null });
  });

  it("hides a partner who was blocked", async () => {
    pairingFindMany.mockResolvedValue([pairing()]);
    loadBlockedPairKeys.mockResolvedValue(new Set([`${VIEWER}:${PARTNER}`]));
    const res = await getEventRecap(VIEWER, EVENT_ID, AFTER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.pairings).toEqual([]);
  });

  // The blind rule, from the reading side. A partner's `true` alone must look
  // exactly like a partner who has not answered at all.
  it("shows no mutual when only the PARTNER has said yes", async () => {
    pairingFindMany.mockResolvedValue([pairing({ thumbsB: true })]);
    const res = await getEventRecap(VIEWER, EVENT_ID, AFTER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.pairings[0]).toEqual({
      pairingId: PAIRING_ID,
      partnerFirstName: "Артём",
      myThumb: null,
      mutual: false,
    });
  });

  // …and a partner's `false` must be indistinguishable from that same silence.
  it("renders a partner's NO identically to a partner who has not answered", async () => {
    pairingFindMany.mockResolvedValue([pairing({ thumbsA: true, thumbsB: false })]);
    const withNo = await getEventRecap(VIEWER, EVENT_ID, AFTER);
    pairingFindMany.mockResolvedValue([pairing({ thumbsA: true, thumbsB: null })]);
    const withSilence = await getEventRecap(VIEWER, EVENT_ID, AFTER);
    expect(withNo.ok && withSilence.ok).toBe(true);
    if (!withNo.ok || !withSilence.ok) return;
    expect(withNo.state.pairings).toEqual(withSilence.state.pairings);
  });
});

describe("recordThumb", () => {
  it("refuses before the thumbs open, and writes nothing", async () => {
    const res = await recordThumb(VIEWER, PAIRING_ID, true, DURING);
    expect(res).toEqual({ ok: false, reason: "not_open" });
    expect(pairingUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a stranger", async () => {
    const res = await recordThumb("99999999-9999-4999-8999-999999999999", PAIRING_ID, true, AFTER);
    expect(res).toEqual({ ok: false, reason: "not_participant" });
    expect(pairingUpdateMany).not.toHaveBeenCalled();
  });

  // The first answer sees nothing back and announces nothing — otherwise it
  // would learn the peer's verdict before committing to its own.
  it("reveals nothing to the first answer", async () => {
    // Completing claim loses (peer has not answered), ordinary write lands.
    pairingUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    pairingFindUnique
      .mockResolvedValueOnce(pairing())
      .mockResolvedValueOnce({ thumbsA: true, thumbsB: null });
    const res = await recordThumb(VIEWER, PAIRING_ID, true, AFTER);
    expect(res).toEqual({ ok: true, mutual: false, revealTo: null });
  });

  // The whole reason for the two-step claim: this is the ONLY call that may
  // announce, and it can only be reached by the second answer.
  it("names the peer to reveal to, exactly once, on the completing answer", async () => {
    pairingFindUnique.mockResolvedValue(pairing({ thumbsB: true }));
    pairingUpdateMany.mockResolvedValueOnce({ count: 1 });
    const res = await recordThumb(VIEWER, PAIRING_ID, true, AFTER);
    expect(res).toEqual({ ok: true, mutual: true, revealTo: PARTNER });
    // One write, not two: the completing claim IS the write.
    expect(pairingUpdateMany).toHaveBeenCalledTimes(1);
    expect(pairingUpdateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: PAIRING_ID,
      thumbsA: null,
      thumbsB: true,
    });
  });

  // A `false` can never complete anything, so it must never even attempt the
  // claim — otherwise a no would be capable of announcing a mutual.
  it("never attempts the completing claim on a NO", async () => {
    pairingFindUnique
      .mockResolvedValueOnce(pairing({ thumbsB: true }))
      .mockResolvedValueOnce({ thumbsA: false, thumbsB: true });
    const res = await recordThumb(VIEWER, PAIRING_ID, false, AFTER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.revealTo).toBeNull();
    expect(res.mutual).toBe(false);
    expect(pairingUpdateMany).toHaveBeenCalledTimes(1);
    expect(pairingUpdateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: PAIRING_ID,
      thumbsA: null,
    });
  });

  // A repeat tap is a no-op rather than a refusal — the CAS simply matches
  // nothing — and it may still read back a mutual the caller has earned.
  it("is idempotent, and re-announces nothing", async () => {
    pairingFindUnique
      .mockResolvedValueOnce(pairing({ thumbsA: true, thumbsB: true }))
      .mockResolvedValueOnce({ thumbsA: true, thumbsB: true });
    pairingUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    const res = await recordThumb(VIEWER, PAIRING_ID, true, AFTER);
    expect(res).toEqual({ ok: true, mutual: true, revealTo: null });
  });
});

describe("submitEventFeedback", () => {
  it("refuses an empty submission rather than spending the incentive on it", async () => {
    const res = await submitEventFeedback(VIEWER, EVENT_ID, {}, AFTER);
    expect(res).toEqual({ ok: false, reason: "empty" });
    expect(feedbackUpsert).not.toHaveBeenCalled();
    expect(grantEventFeedbackDiscount).not.toHaveBeenCalled();
  });

  it("refuses a rating off the 1..10 scale", async () => {
    const res = await submitEventFeedback(VIEWER, EVENT_ID, { rating: 11 }, AFTER);
    expect(res).toEqual({ ok: false, reason: "bad_rating" });
    expect(feedbackUpsert).not.toHaveBeenCalled();
  });

  it("drops a safety value it does not recognise instead of storing it", async () => {
    await submitEventFeedback(VIEWER, EVENT_ID, { rating: 8, safety: "meh" }, AFTER);
    expect(feedbackUpsert.mock.calls[0]?.[0]?.create.safety).toBeNull();
  });

  it("alerts the founder on `unsafe`, and only on `unsafe`", async () => {
    await submitEventFeedback(VIEWER, EVENT_ID, { safety: "uncomfortable" }, AFTER);
    expect(notifyFounderEventSafetyFlag).not.toHaveBeenCalled();
    await submitEventFeedback(VIEWER, EVENT_ID, { safety: "unsafe", text: "  x  " }, AFTER);
    expect(notifyFounderEventSafetyFlag).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      userId: VIEWER,
      text: "x",
    });
  });

  // Answering must never take something away: a user already holding a famine
  // discount keeps it and is told what they actually have.
  it("reports the existing discount when the grant was skipped", async () => {
    const expiresAt = new Date("2026-10-01T00:00:00.000Z");
    grantEventFeedbackDiscount.mockResolvedValue({ granted: false });
    getActiveDiscount.mockResolvedValue({ pct: 77, expiresAt });
    const res = await submitEventFeedback(VIEWER, EVENT_ID, { rating: 9 }, AFTER);
    expect(res).toEqual({
      ok: true,
      granted: false,
      discount: { pct: 77, expiresAt: expiresAt.toISOString() },
    });
  });

  it("is refused to someone who never came", async () => {
    ticketFindUnique.mockResolvedValue({ checkedInAt: null });
    const res = await submitEventFeedback(VIEWER, EVENT_ID, { rating: 9 }, AFTER);
    expect(res).toEqual({ ok: false, reason: "not_attended" });
    expect(feedbackUpsert).not.toHaveBeenCalled();
  });
});
