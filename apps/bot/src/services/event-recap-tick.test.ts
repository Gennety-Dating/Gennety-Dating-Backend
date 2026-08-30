/**
 * The scheduled half of the post-event loop (LAUNCH_EVENTS §11).
 *
 * Three properties carry this file:
 *
 *  1. **The recap is stamped per attendee, only after it actually sent.** A
 *     stamp on a failed send loses the one message the whole loop hangs off,
 *     and a stamp shared by the event loses everyone when one phone is
 *     unreachable.
 *  2. **A mutual the allocator refuses is retried, not dropped** — and giving
 *     up is bounded by the window rather than by a column, because the
 *     allocator cannot tell "mid-date" from "banned forever".
 *  3. **The window is a window.** An event too fresh must not be recapped and
 *     an event too old must not be swept, and both edges are arithmetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = { TICKET_FEATURE_ENABLED: false };
vi.mock("../config.js", () => ({ env: envMock }));

const eventFindMany = vi.fn();
const ticketFindMany = vi.fn();
const ticketUpdateMany = vi.fn();
const pairingFindMany = vi.fn();
const pairingUpdateMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    event: { findMany: (...a: unknown[]) => eventFindMany(...a) },
    eventTicket: {
      findMany: (...a: unknown[]) => ticketFindMany(...a),
      updateMany: (...a: unknown[]) => ticketUpdateMany(...a),
    },
    eventRoundPairing: {
      findMany: (...a: unknown[]) => pairingFindMany(...a),
      updateMany: (...a: unknown[]) => pairingUpdateMany(...a),
    },
    user: { findUnique: vi.fn() },
  },
}));

const createProposedMatch = vi.fn();
vi.mock("./match-engine.js", () => ({
  createProposedMatch: (...a: unknown[]) => createProposedMatch(...a),
}));

const loadBlockedPairKeys = vi.fn();
vi.mock("./user-block.js", () => ({
  loadBlockedPairKeys: (...a: unknown[]) => loadBlockedPairKeys(...a),
}));

vi.mock("./push.js", () => ({ sendPushToUser: vi.fn() }));
vi.mock("./main-bot-api.js", () => ({ getMainBotApi: () => null }));
vi.mock("./mini-app-url.js", () => ({ buildMiniAppUrl: () => "https://example.test/event.html" }));
vi.mock("../handlers/matching/ticket-gate.js", () => ({
  sendTicketOffer: vi.fn(),
  ticketGateDeadline: () => new Date("2026-09-14T12:00:00.000Z"),
}));
vi.mock("../handlers/matching/scheduler.js", () => ({ startScheduling: vi.fn() }));

const { runEventRecapTick } = await import("./event-recap-tick.js");
const { RECAP_DELAY_MS, THUMBS_OPEN_DELAY_MS, MUTUAL_MATCH_WINDOW_MS } = await import(
  "./event-recap.js"
);

const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "55555555-5555-4555-8555-555555555555";
const PAIRING_ID = "44444444-4444-4444-8444-444444444444";

const ENDED_AT = new Date("2026-09-12T21:00:00.000Z");
/** Past T+18h — the recap is due. */
const NEXT_DAY = new Date(ENDED_AT.getTime() + RECAP_DELAY_MS + 60_000);
/** Past T+2h but well before T+18h — the sweep runs, the recap does not. */
const SAME_NIGHT = new Date(ENDED_AT.getTime() + THUMBS_OPEN_DELAY_MS + 60_000);

function ticket(userId: string, id = `t-${userId}`) {
  return { id, userId, user: { language: "ru" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.TICKET_FEATURE_ENABLED = false;
  eventFindMany.mockResolvedValue([{ id: EVENT_ID, title: "Launch", endsAt: ENDED_AT }]);
  ticketFindMany.mockResolvedValue([]);
  ticketUpdateMany.mockResolvedValue({ count: 1 });
  pairingFindMany.mockResolvedValue([]);
  pairingUpdateMany.mockResolvedValue({ count: 1 });
  loadBlockedPairKeys.mockResolvedValue(new Set<string>());
  createProposedMatch.mockResolvedValue({ id: "match-1" });
});

describe("the scan window", () => {
  it("only looks at events that have run, and only back as far as the mutual window", async () => {
    const now = new Date("2026-09-20T10:00:00.000Z");
    await runEventRecapTick(now, {});
    const where = eventFindMany.mock.calls[0]?.[0]?.where;
    expect(where.status).toEqual({ in: ["live", "concluded"] });
    expect(where.endsAt.lte).toEqual(new Date(now.getTime() - THUMBS_OPEN_DELAY_MS));
    expect(where.endsAt.gte).toEqual(new Date(now.getTime() - MUTUAL_MATCH_WINDOW_MS));
  });

  // The mutual sweep runs from T+2h; the recap waits for T+18h. Conflating the
  // two would either delay every match by most of a day or wake people at 1am.
  it("sweeps mutuals the same night but sends no recap yet", async () => {
    ticketFindMany.mockResolvedValue([ticket(A)]);
    pairingFindMany.mockResolvedValue([{ id: PAIRING_ID, userAId: A, userBId: B }]);
    const notify = vi.fn();
    const result = await runEventRecapTick(SAME_NIGHT, { notify, onMatchCreated: vi.fn() });
    expect(notify).not.toHaveBeenCalled();
    expect(result.recapsSent).toBe(0);
    expect(result.matchesCreated).toBe(1);
  });
});

describe("the recap fan-out", () => {
  it("counts only met-confirmed pairs, and not through a block", async () => {
    ticketFindMany.mockResolvedValue([ticket(A)]);
    pairingFindMany.mockResolvedValueOnce([
      { userAId: A, userBId: B },
      { userAId: A, userBId: C },
    ]);
    loadBlockedPairKeys.mockResolvedValue(new Set([`${A}:${C}`, `${C}:${A}`]));
    const notify = vi.fn();
    await runEventRecapTick(NEXT_DAY, { notify, onMatchCreated: vi.fn() });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[1]?.metCount).toBe(1);
    // And the query itself asked for met-confirmed pairs only.
    const where = pairingFindMany.mock.calls[0]?.[0]?.where;
    expect(where.metConfirmedA).toEqual({ not: null });
    expect(where.metConfirmedB).toEqual({ not: null });
  });

  it("sends to someone who found nobody, with a zero count for the copy to switch on", async () => {
    ticketFindMany.mockResolvedValue([ticket(A)]);
    const notify = vi.fn();
    await runEventRecapTick(NEXT_DAY, { notify, onMatchCreated: vi.fn() });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[1]?.metCount).toBe(0);
  });

  it("stamps only after a successful send, and per ticket", async () => {
    ticketFindMany.mockResolvedValue([ticket(A, "t-a"), ticket(B, "t-b")]);
    const notify = vi.fn(async (userId: string) => {
      if (userId === A) throw new Error("unreachable");
    });
    const result = await runEventRecapTick(NEXT_DAY, { notify, onMatchCreated: vi.fn() });
    expect(result).toMatchObject({ recapsSent: 1, recapsFailed: 1 });
    // Only B's ticket is stamped — A's is left for the next tick to retry.
    expect(ticketUpdateMany).toHaveBeenCalledTimes(1);
    expect(ticketUpdateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "t-b",
      recapSentAt: null,
    });
  });

  it("never picks up a ticket that was already recapped", async () => {
    await runEventRecapTick(NEXT_DAY, { notify: vi.fn(), onMatchCreated: vi.fn() });
    expect(ticketFindMany.mock.calls[0]?.[0]?.where).toEqual({
      eventId: EVENT_ID,
      checkedInAt: { not: null },
      recapSentAt: null,
    });
  });

  it("does not fan out to people who claimed a place and never came", async () => {
    // Expressed as the query's own filter rather than as a post-filter: a
    // recap is about an evening you were at.
    await runEventRecapTick(NEXT_DAY, { notify: vi.fn(), onMatchCreated: vi.fn() });
    expect(ticketFindMany.mock.calls[0]?.[0]?.where.checkedInAt).toEqual({ not: null });
  });
});

describe("the mutual sweep", () => {
  beforeEach(() => {
    pairingFindMany.mockResolvedValue([{ id: PAIRING_ID, userAId: A, userBId: B }]);
  });

  it("only considers pairings where BOTH said yes and no match exists yet", async () => {
    await runEventRecapTick(SAME_NIGHT, { notify: vi.fn(), onMatchCreated: vi.fn() });
    const call = pairingFindMany.mock.calls.at(-1)?.[0];
    expect(call.where).toEqual({
      eventId: EVENT_ID,
      thumbsA: true,
      thumbsB: true,
      matchId: null,
    });
  });

  // The row is born already accepted, at `negotiating`, because both people
  // have answered — a `proposed` row would ask them a question they answered.
  it("creates the match pre-accepted and stamped `event`", async () => {
    await runEventRecapTick(SAME_NIGHT, { notify: vi.fn(), onMatchCreated: vi.fn() });
    expect(createProposedMatch).toHaveBeenCalledWith(A, B, undefined, undefined, {
      source: "event",
      preAccepted: true,
    });
  });

  // The §3.5b hole, one stage on: a `negotiating` row with no gate deadline is
  // invisible to the ticket sweep AND exempt from the stall chain at once.
  it("arms the ticket-gate deadline in the same call when tickets are on", async () => {
    envMock.TICKET_FEATURE_ENABLED = true;
    await runEventRecapTick(SAME_NIGHT, { notify: vi.fn(), onMatchCreated: vi.fn() });
    expect(createProposedMatch.mock.calls[0]?.[4]).toEqual({
      source: "event",
      preAccepted: true,
      ticketGateExpiresAt: new Date("2026-09-14T12:00:00.000Z"),
    });
  });

  it("writes NO score log — nothing was scored", async () => {
    await runEventRecapTick(SAME_NIGHT, { notify: vi.fn(), onMatchCreated: vi.fn() });
    expect(createProposedMatch.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("links the pairing on a CAS, and hands the match off", async () => {
    const onMatchCreated = vi.fn();
    await runEventRecapTick(SAME_NIGHT, { notify: vi.fn(), onMatchCreated });
    expect(pairingUpdateMany).toHaveBeenCalledWith({
      where: { id: PAIRING_ID, matchId: null },
      data: { matchId: "match-1" },
    });
    expect(onMatchCreated).toHaveBeenCalledWith("match-1");
  });

  // A refusal is "not yet", and the row keeps its null `matchId` so the next
  // tick tries again. Nothing is written and nothing is announced.
  it("defers a mutual the allocator refuses instead of dropping it", async () => {
    createProposedMatch.mockResolvedValue(null);
    const onMatchCreated = vi.fn();
    const result = await runEventRecapTick(SAME_NIGHT, { notify: vi.fn(), onMatchCreated });
    expect(result).toMatchObject({ matchesCreated: 0, matchesDeferred: 1 });
    expect(pairingUpdateMany).not.toHaveBeenCalled();
    expect(onMatchCreated).not.toHaveBeenCalled();
  });

  // Blocks are absolute (§2), and this is the third path that can pair two
  // people — the only one that produces a DATE. It must refuse on its own
  // rather than lean on the lifetime pair ban inside `createProposedMatch`:
  // that ban catches a blocked pair today only because a block can only be
  // filed against an existing match, and PRODUCT_SPEC §Blocking keeps the
  // block's own enforcement redundant precisely because the ban is under
  // periodic review.
  it("never hands a blocked pair to the allocator, in either direction", async () => {
    loadBlockedPairKeys.mockResolvedValue(new Set([`${B}:${A}`, `${A}:${B}`]));
    const onMatchCreated = vi.fn();
    const result = await runEventRecapTick(SAME_NIGHT, { notify: vi.fn(), onMatchCreated });
    expect(createProposedMatch).not.toHaveBeenCalled();
    expect(pairingUpdateMany).not.toHaveBeenCalled();
    expect(onMatchCreated).not.toHaveBeenCalled();
    // Counted apart from `deferred`: a block never resolves into a match, so
    // reporting it as "retrying next tick" would misdescribe it — and would
    // hide a pair being re-offered every five minutes for fourteen days.
    expect(result).toMatchObject({
      matchesCreated: 0,
      matchesDeferred: 0,
      matchesBlocked: 1,
    });
  });

  // A card that fails to send costs the pair their card, never their match:
  // the row is live with its deadline armed, so both sweeps own it either way.
  it("keeps the match when the handoff throws", async () => {
    const onMatchCreated = vi.fn(async () => {
      throw new Error("telegram down");
    });
    const result = await runEventRecapTick(SAME_NIGHT, { notify: vi.fn(), onMatchCreated });
    expect(result.matchesCreated).toBe(1);
    expect(pairingUpdateMany).toHaveBeenCalled();
  });
});
