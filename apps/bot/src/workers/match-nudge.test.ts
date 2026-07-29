import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    profile: { update: vi.fn() },
  },
}));

// The stall chain's cancellation settles Elo/priority — stub both so the worker
// tests stay about scheduling and dispatch. Their own behaviour is covered in
// `services/match-stall.test.ts`.
vi.mock("../services/match-decision-shared.js", () => ({
  boostAcceptedSidePriority: vi.fn().mockResolvedValue(true),
}));
vi.mock("../utils/elo-calculator.js", () => ({
  applySilentIgnorePenalty: vi.fn().mockResolvedValue(495),
}));

// Mutable so a test can flip the Date Ticket gate — the scheduling query only
// filters on `ticketStatus` while that feature is on (see the worker's comment:
// with it off, `ticketStatus` never leaves its "pending" default and an
// unconditional filter would suppress every scheduling nudge).
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    OPENAI_API_KEY: "test-key",
    TICKET_FEATURE_ENABLED: false,
    // The venue nudge attaches the Location Mini App button.
    WEBAPP_URL: "https://test.invalid",
  } as {
    OPENAI_API_KEY: string;
    TICKET_FEATURE_ENABLED: boolean;
    WEBAPP_URL: string;
  },
}));

vi.mock("../config.js", () => ({ env: mockEnv }));

import { prisma } from "@gennety/db";
import {
  matchNudgeTick,
  PROPOSAL_NUDGE1_MS,
  PROPOSAL_NUDGE2_MS,
  PROPOSAL_DEADLINE_NUDGE_LEAD_MS,
} from "./match-nudge.js";

// 24h TTL — kept in sync with PROPOSAL_TTL_MS in countdown-plate.ts.
const TTL_MS = 24 * 60 * 60 * 1000;

// 2024-06-15 — Kyiv summer time (UTC+3). C-8 anchored quiet hours to Kyiv,
// so we pick UTC instants whose Kyiv-local hour is unambiguously day/quiet.
const DAY_TIME = new Date("2024-06-15T11:00:00Z"); //   14:00 Kyiv — daytime
const QUIET_TIME = new Date("2024-06-15T02:00:00Z"); // 05:00 Kyiv — quiet

function createMockApi() {
  return { sendMessage: vi.fn().mockResolvedValue({}) } as any;
}

function openaiOk(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function makeProposedMatch(overrides: Record<string, unknown> = {}) {
  const dispatched = new Date(DAY_TIME.getTime() - PROPOSAL_NUDGE1_MS - 60_000); // 3h+1m ago
  return {
    id: "match-1",
    dispatchedAt: dispatched,
    proposalNudge1SentAt: null,
    proposalNudge2SentAt: null,
    acceptedByA: null,
    acceptedByB: null,
    pitchForA: "She loves jazz and late-night philosophy debates.",
    pitchForB: "He's into hiking and cooking.",
    userA: { telegramId: BigInt(1), language: "en", firstName: "Alice" },
    userB: { telegramId: BigInt(2), language: "en", firstName: "Bob" },
    ...overrides,
  };
}

function makeNegotiatingMatch(overrides: Record<string, unknown> = {}) {
  // Both accepted, neither has marked availability. Anchor `dispatchedAt` 6h+1m
  // ago to clear the scheduling-phase nudge1 cutoff (SCHED_NUDGE1_MS = 6h).
  const dispatched = new Date(DAY_TIME.getTime() - 6 * 60 * 60_000 - 60_000);
  return {
    id: "match-2",
    dispatchedAt: dispatched,
    schedNudge1SentAt: null,
    schedNudge2SentAt: null,
    availableTimesA: [],
    availableTimesB: [],
    schedulingIteration: 1,
    userA: { telegramId: BigInt(11), language: "en", firstName: "Carol" },
    userB: { telegramId: BigInt(12), language: "en", firstName: "Dan" },
    ...overrides,
  };
}

describe("matchNudgeTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TICKET_FEATURE_ENABLED = false;
    (prisma.match.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    // Default so the third (deadline) findMany call in matchNudgeTick returns
    // an empty set; individual tests still override the proposal/scheduling
    // queries via `mockResolvedValueOnce`, which take precedence in call order.
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("returns zeros during quiet hours without DB query", async () => {
    const api = createMockApi();
    const result = await matchNudgeTick(api, { now: QUIET_TIME });

    expect(result).toEqual({
      proposalNudges: 0,
      schedNudges: 0,
      deadlineNudges: 0,
      venueNudges: 0,
      stallCheckIns: 0,
      stallTimeouts: 0,
    });
    expect(prisma.match.findMany).not.toHaveBeenCalled();
  });

  it("sends nudge 1 to both users who haven't accepted", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeProposedMatch()]) // proposal query
      .mockResolvedValueOnce([]);                   // scheduling query

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Did you see your match? 👀"));
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.proposalNudges).toBe(2); // Alice + Bob
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenCalledWith(1, expect.any(String), expect.anything());
    expect(api.sendMessage).toHaveBeenCalledWith(2, expect.any(String), expect.anything());
    // stamps proposalNudge1SentAt (C-6 split column)
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { proposalNudge1SentAt: DAY_TIME } }),
    );
  });

  it("sends nudge 1 only to the user who hasn't accepted", async () => {
    const match = makeProposedMatch({ acceptedByA: true }); // A accepted, B didn't
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([match])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Hey!"));
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.proposalNudges).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledWith(2, expect.any(String), expect.anything());
  });

  it("sends nudge 2 (not nudge 1 again) when ≥10h elapsed and nudge1 already sent", async () => {
    const dispatched = new Date(DAY_TIME.getTime() - PROPOSAL_NUDGE2_MS - 60_000);
    const match = makeProposedMatch({
      dispatchedAt: dispatched,
      proposalNudge1SentAt: new Date(DAY_TIME.getTime() - 5 * 60 * 60_000),
      proposalNudge2SentAt: null,
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([match])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Last chance!"));
    const api = createMockApi();

    await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { proposalNudge2SentAt: DAY_TIME } }),
    );
  });

  it("C-6: scheduling-phase reads schedNudge*, NOT proposalNudge*", async () => {
    // Regression: pre-fix, proposal-phase stamps blocked scheduling-phase
    // nudges via the shared nudge1/2SentAt columns. Verify that a row with
    // proposalNudge1/2 set still gets a fresh schedNudge1.
    const match = makeNegotiatingMatch({
      proposalNudge1SentAt: new Date(DAY_TIME.getTime() - 8 * 60 * 60_000),
      proposalNudge2SentAt: new Date(DAY_TIME.getTime() - 7 * 60 * 60_000),
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // proposal query empty
      .mockResolvedValueOnce([match]); // scheduling query

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Pick a time!"));
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.schedNudges).toBe(2); // both Carol + Dan
    // Stamps schedNudge1SentAt — NOT proposalNudge*.
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { schedNudge1SentAt: DAY_TIME } }),
    );
  });

  it("nudges only the side that hasn't marked availability", async () => {
    // Regression: this used to key off `pickedTimeA/B`, the dead pre-2026-05
    // columns nothing writes — so both sides were always nudged, including one
    // who had already opened the Calendar and marked their slots.
    const match = makeNegotiatingMatch({
      availableTimesA: [new Date("2024-06-20T16:00:00Z")],
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([match]);

    const api = createMockApi();
    const result = await matchNudgeTick(api, {
      fetchFn: vi.fn().mockResolvedValue(openaiOk("Pick a time!")),
      now: DAY_TIME,
    });

    expect(result.schedNudges).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledWith(12, expect.any(String), expect.anything());
  });

  it("excludes matches still on the Date Ticket gate when the gate is on", async () => {
    // `negotiating` also covers the §3.5b ticket gate, where the Calendar has
    // not been sent — "pick a time" there points at a screen the user lacks.
    mockEnv.TICKET_FEATURE_ENABLED = true;

    const api = createMockApi();
    await matchNudgeTick(api, { fetchFn: vi.fn(), now: DAY_TIME });

    const schedWhere = (prisma.match.findMany as ReturnType<typeof vi.fn>).mock.calls[1]![0].where;
    expect(schedWhere.ticketStatus).toEqual({
      notIn: ["pending", "partial", "refund_pending"],
    });
  });

  it("does NOT filter on ticketStatus when the gate is off", async () => {
    // With the feature off nothing ever advances `ticketStatus` past its
    // "pending" schema default, so an unconditional filter would silently
    // suppress EVERY scheduling nudge.
    mockEnv.TICKET_FEATURE_ENABLED = false;

    const api = createMockApi();
    await matchNudgeTick(api, { fetchFn: vi.fn(), now: DAY_TIME });

    const schedWhere = (prisma.match.findMany as ReturnType<typeof vi.fn>).mock.calls[1]![0].where;
    expect(schedWhere.ticketStatus).toBeUndefined();
  });

  it("C-6: scheduling phase skips mobile-only users (telegramId <= 0n)", async () => {
    const match = makeNegotiatingMatch({
      userB: { telegramId: -10n, language: "en", firstName: "MobileDan" },
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([match]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Pick a time!"));
    const api = createMockApi();
    await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    // Only Carol (positive id) is messaged.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(11, expect.any(String), expect.anything());
  });

  it("uses fallback when OpenAI fails", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeProposedMatch()])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.proposalNudges).toBe(2);
    const sentText: string = api.sendMessage.mock.calls[0][1];
    expect(sentText.length).toBeGreaterThan(0);
  });

  it("skips blocked users and continues", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeProposedMatch()])
      .mockResolvedValueOnce([]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Hey!"));
    const api = createMockApi();
    api.sendMessage.mockRejectedValue(new Error("Forbidden"));

    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    // Failed sends don't increment the count, but we still stamped the match
    expect(result.proposalNudges).toBe(0);
    expect(prisma.match.updateMany).toHaveBeenCalled();
  });

  it("fires the deadline nudge to undecided sides ~2h before the 24h TTL", async () => {
    // Dispatched 22h30m ago → ~1h30m left, inside the [TTL-2h, TTL) window.
    const dispatched = new Date(
      DAY_TIME.getTime() - (TTL_MS - PROPOSAL_DEADLINE_NUDGE_LEAD_MS) - 30 * 60_000,
    );
    const match = makeProposedMatch({
      dispatchedAt: dispatched,
      // Past the 3h/10h anchors, but both those nudges already went out; only
      // the deadline query should claim this row now.
      proposalNudge1SentAt: new Date(DAY_TIME.getTime() - 19 * 60 * 60_000),
      proposalNudge2SentAt: new Date(DAY_TIME.getTime() - 12 * 60 * 60_000),
      proposalDeadlineNudgeSentAt: null,
    });
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // proposal query (already fully nudged)
      .mockResolvedValueOnce([]) // scheduling query
      .mockResolvedValueOnce([match]); // deadline query

    const api = createMockApi();
    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.deadlineNudges).toBe(2); // Alice + Bob, both undecided
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { proposalDeadlineNudgeSentAt: DAY_TIME } }),
    );
  });

  it("deadline nudge skips a side that already declined (committed)", async () => {
    const dispatched = new Date(
      DAY_TIME.getTime() - (TTL_MS - PROPOSAL_DEADLINE_NUDGE_LEAD_MS) - 30 * 60_000,
    );
    const match = makeProposedMatch({
      dispatchedAt: dispatched,
      acceptedByA: false, // Alice already passed — never nag
      acceptedByB: null, // Bob still undecided
      proposalDeadlineNudgeSentAt: null,
    });
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([match]);

    const api = createMockApi();
    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.deadlineNudges).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledWith(2, expect.any(String));
  });

  it("does not send when another worker already claimed the nudge", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeProposedMatch()])
      .mockResolvedValueOnce([]);
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.proposalNudges).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Venue nudges + the planning-stall chain (PRODUCT_SPEC §3.5c).
//
// These route `findMany` by the queried status instead of chaining
// `mockResolvedValueOnce`: five queries now run in one tick, and an
// order-dependent chain would silently re-point at a different branch the next
// time a handler is added.
// ---------------------------------------------------------------------------

const STALL_CHECK_IN_MS = 24 * 60 * 60 * 1000;
const STALL_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const SLOT = new Date("2026-08-01T16:00:00Z");

function makeVenueMatch(overrides: Record<string, unknown> = {}) {
  // Side A owes its departure point + vibe; side B is done and waiting.
  return {
    id: "match-v",
    status: "negotiating_venue",
    userAId: "user-a",
    userBId: "user-b",
    dispatchedAt: new Date(DAY_TIME.getTime() - 40 * 60 * 60_000),
    schedulingOpenedAt: new Date(DAY_TIME.getTime() - 30 * 60 * 60_000),
    venuePromptAskedAt: new Date(DAY_TIME.getTime() - 7 * 60 * 60_000),
    proposedTimes: [SLOT],
    availableTimesA: [SLOT],
    availableTimesB: [SLOT],
    vibeTextA: null,
    vibeLatA: null,
    vibeLngA: null,
    vibeTextB: "park walk",
    vibeLatB: 50.4,
    vibeLngB: 30.5,
    venueNudge1SentAt: null,
    venueNudge2SentAt: null,
    stallCheckInSentAtA: null,
    stallCheckInSentAtB: null,
    stallConfirmedAtA: null,
    stallConfirmedAtB: null,
    userA: { id: "user-a", telegramId: 21n, language: "en", firstName: "Alice", theme: "dark" },
    userB: { id: "user-b", telegramId: 22n, language: "en", firstName: "Bob", theme: "dark" },
    ...overrides,
  };
}

/** Route each of the tick's queries to its own fixture by queried status. */
function routeFindMany(rows: { venue?: unknown[]; stall?: unknown[] }) {
  (prisma.match.findMany as ReturnType<typeof vi.fn>).mockImplementation(
    (args: { where?: { status?: unknown } }) => {
      const status = args?.where?.status;
      if (status === "negotiating_venue") return Promise.resolve(rows.venue ?? []);
      if (typeof status === "object" && status !== null && "in" in status) {
        return Promise.resolve(rows.stall ?? []);
      }
      return Promise.resolve([]);
    },
  );
}

describe("matchNudgeTick — venue nudges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TICKET_FEATURE_ENABLED = false;
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  });

  it("nudges only the side that still owes, and carries the map button", async () => {
    routeFindMany({ venue: [makeVenueMatch()] });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.venueNudges).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    const [chatId, , opts] = api.sendMessage.mock.calls[0];
    expect(chatId).toBe(21);
    // Static copy is pointless without the Mini App entry — the departure point
    // can only be marked on the map.
    expect(JSON.stringify(opts)).toContain("location.html");
  });

  it("says nothing once both sides have submitted", async () => {
    routeFindMany({
      venue: [makeVenueMatch({ vibeTextA: "quiet cafe", vibeLatA: 50.45, vibeLngA: 30.52 })],
    });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.venueNudges).toBe(0);
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });
});

describe("matchNudgeTick — stall chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TICKET_FEATURE_ENABLED = false;
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      silentIgnoreCount: 1,
    });
  });

  it("asks the quiet side at 24h and tells the waiting side it happened", async () => {
    const asked = new Date(DAY_TIME.getTime() - STALL_CHECK_IN_MS - 60_000);
    routeFindMany({ stall: [makeVenueMatch({ venuePromptAskedAt: asked })] });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.stallCheckIns).toBe(1);
    const byChat = new Map<number, unknown[]>(
      (api.sendMessage.mock.calls as unknown[][]).map((c) => [Number(c[0]), c]),
    );
    // The quiet side gets the question, with both answers on it.
    expect(JSON.stringify(byChat.get(21)?.[2])).toContain("stall:ok:match-v");
    expect(JSON.stringify(byChat.get(21)?.[2])).toContain("stall:no:match-v");
    // The side that did its part learns something is being done about the wait.
    expect(String(byChat.get(22)?.[1])).toContain("Alice");
  });

  it("stays quiet before the 24h mark", async () => {
    const asked = new Date(DAY_TIME.getTime() - STALL_CHECK_IN_MS + 60 * 60_000);
    routeFindMany({ stall: [makeVenueMatch({ venuePromptAskedAt: asked })] });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.stallCheckIns).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("asks once — a stamped check-in is not repeated", async () => {
    const asked = new Date(DAY_TIME.getTime() - STALL_CHECK_IN_MS - 60_000);
    routeFindMany({
      stall: [
        makeVenueMatch({
          venuePromptAskedAt: asked,
          stallCheckInSentAtA: new Date(DAY_TIME.getTime() - 60 * 60_000),
        }),
      ],
    });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.stallCheckIns).toBe(0);
  });

  it("cancels at 48h instead of asking again", async () => {
    const asked = new Date(DAY_TIME.getTime() - STALL_TIMEOUT_MS - 60_000);
    const match = makeVenueMatch({ venuePromptAskedAt: asked });
    routeFindMany({ stall: [match] });
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(match);
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.stallTimeouts).toBe(1);
    expect(result.stallCheckIns).toBe(0);
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "cancelled" } }),
    );
  });

  it("leaves the Date Ticket gate alone (negotiating with no slots yet)", async () => {
    // That wait has its own deadline and refund policy; stalling it here could
    // cancel a match over an unpaid ticket.
    routeFindMany({
      stall: [
        makeVenueMatch({
          status: "negotiating",
          proposedTimes: [],
          venuePromptAskedAt: null,
          schedulingOpenedAt: new Date(DAY_TIME.getTime() - STALL_TIMEOUT_MS - 60_000),
        }),
      ],
    });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.stallCheckIns).toBe(0);
    expect(result.stallTimeouts).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("never asks or cancels on a side with no Telegram presence", async () => {
    const asked = new Date(DAY_TIME.getTime() - STALL_TIMEOUT_MS - 60_000);
    const match = makeVenueMatch({
      venuePromptAskedAt: asked,
      userA: { id: "user-a", telegramId: -21n, language: "en", firstName: "Alice", theme: "dark" },
    });
    routeFindMany({ stall: [match] });
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(match);
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.stallCheckIns).toBe(0);
    expect(result.stallTimeouts).toBe(0);
  });
});
