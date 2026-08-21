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

// The app rail. `services/match-stall.ts` imports the same module for its
// cancellation notices, so this one mock covers every push in the tick.
vi.mock("../services/push.js", () => ({
  sendPushToUser: vi.fn(),
  sendPushToUsers: vi.fn(),
  sendLiveActivityUpdateToUser: vi.fn(),
  sendLiveActivityStartToUser: vi.fn(),
}));

// Mutable so a test can flip the Date Ticket gate. The scheduling reminder is
// deliberately blind to it — a pair still inside the gate is recognised by an
// empty `proposedTimes`, which holds under either flag (see the worker).
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
import { t } from "@gennety/shared";
import { sendPushToUser } from "../services/push.js";
import {
  matchNudgeTick,
  DEADLINE_NUDGE_PUSH_TYPE,
  MATCH_NUDGE_PUSH_TYPE,
  PLANNING_NUDGE_PUSH_TYPE,
  PROPOSAL_NUDGE1_MS,
  PROPOSAL_NUDGE2_MS,
  PROPOSAL_DEADLINE_NUDGE_LEAD_MS,
} from "./match-nudge.js";

const mPush = sendPushToUser as unknown as ReturnType<typeof vi.fn>;

// 24h TTL — the active (weekly, "fixed") cadence profile's flat proposal
// window. Matches services/proposal-deadline.ts's deadlineFor() under
// DROP_CADENCE=weekly (the default, and what this test suite runs under).
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

const SCHED_SLOT = new Date("2024-06-20T16:00:00Z");
const SCHED_SLOT_2 = new Date("2024-06-21T16:00:00Z");

function makeNegotiatingMatch(overrides: Record<string, unknown> = {}) {
  // Both accepted, neither has marked availability. Anchor `dispatchedAt` 6h+1m
  // ago to clear the scheduling-phase nudge1 cutoff (SCHED_NUDGE1_MS = 6h).
  // The row carries the full STALL_MATCH_SELECT shape: "whose move is it" is
  // now one shared predicate across the reminder, the check-in and the 48h
  // cancellation, so the reminder reads the same columns they do.
  const dispatched = new Date(DAY_TIME.getTime() - 6 * 60 * 60_000 - 60_000);
  return {
    id: "match-2",
    status: "negotiating",
    userAId: "user-a",
    userBId: "user-b",
    dispatchedAt: dispatched,
    schedulingOpenedAt: dispatched,
    venuePromptAskedAt: null,
    // Non-empty = the Calendar actually opened (the ticket gate has settled, or
    // was never on). This is what tells a stalled pair apart from one still
    // inside the §3.5b gate.
    proposedTimes: [SCHED_SLOT, SCHED_SLOT_2],
    schedNudge1SentAt: null,
    schedNudge2SentAt: null,
    availableTimesA: [],
    availableTimesB: [],
    vibeTextA: null,
    vibeLatA: null,
    vibeLngA: null,
    vibeTextB: null,
    vibeLatB: null,
    vibeLngB: null,
    stallCheckInSentAtA: null,
    stallCheckInSentAtB: null,
    stallConfirmedAtA: null,
    stallConfirmedAtB: null,
    venueNudge1SentAt: null,
    venueNudge2SentAt: null,
    schedulingIteration: 1,
    userA: {
      id: "user-a",
      telegramId: BigInt(11),
      language: "en",
      firstName: "Carol",
      theme: "dark",
    },
    userB: {
      id: "user-b",
      telegramId: BigInt(12),
      language: "en",
      firstName: "Dan",
      theme: "dark",
    },
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

  it("says nothing while the Date Ticket gate is still open — under either flag", async () => {
    // `negotiating` also covers the §3.5b ticket gate, where the Calendar has
    // not been sent — "pick a time" there points at a screen the user lacks.
    // The discriminator is `proposedTimes` (written by `startScheduling` when
    // and only when the Calendar opens), NOT `ticketStatus`: that column keeps
    // its "pending" default even with the feature switched off entirely, so a
    // filter on it would have to be flag-conditional to avoid suppressing every
    // scheduling nudge. Same rule the stall chain already runs on.
    for (const gateOn of [true, false]) {
      vi.clearAllMocks();
      (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      mockEnv.TICKET_FEATURE_ENABLED = gateOn;

      (prisma.match.findMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeNegotiatingMatch({ proposedTimes: [] })])
        .mockResolvedValue([]);

      const api = createMockApi();
      const result = await matchNudgeTick(api, { fetchFn: vi.fn(), now: DAY_TIME });

      expect(result.schedNudges).toBe(0);
      expect(api.sendMessage).not.toHaveBeenCalled();
    }
  });

  it("reminds BOTH sides — with the calendar button — when their picks don't overlap", async () => {
    // The state the §3.6b shimmer used to cover with a "we're coordinating a
    // time" status for both sides. It is not a wait: each of them has to widen
    // their selection or take one of the other's slots, so it gets a reminder.
    // Static copy, because a generated "pick a time" line would be wrong — they
    // did pick — and because the useful part is the way back into the Mini App,
    // the Calendar card having scrolled away hours ago.
    const match = makeNegotiatingMatch({
      availableTimesA: [SCHED_SLOT],
      availableTimesB: [SCHED_SLOT_2],
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([match]);

    const mockFetch = vi.fn();
    const api = createMockApi();
    const result = await matchNudgeTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.schedNudges).toBe(2);
    expect(mockFetch).not.toHaveBeenCalled();
    for (const chatId of [11, 12]) {
      expect(api.sendMessage).toHaveBeenCalledWith(
        chatId,
        t("en", "matchScheduleNoOverlapYet"),
        expect.objectContaining({
          reply_markup: expect.objectContaining({ inline_keyboard: expect.anything() }),
        }),
      );
    }
  });

  it("stays silent once a shared slot exists (the date auto-locks)", async () => {
    const match = makeNegotiatingMatch({
      availableTimesA: [SCHED_SLOT, SCHED_SLOT_2],
      availableTimesB: [new Date(SCHED_SLOT.getTime())],
    });

    (prisma.match.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([match]);

    const api = createMockApi();
    const result = await matchNudgeTick(api, { fetchFn: vi.fn(), now: DAY_TIME });

    expect(result.schedNudges).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
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

describe("matchNudgeTick — stall phase scoping (audit regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TICKET_FEATURE_ENABLED = false;
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  });

  it("still asks at the venue step when the stamp is left over from scheduling", async () => {
    // Regression: the stamp is per side but not per phase. A user asked at the
    // calendar who answered by picking a time (never tapping green) carried the
    // stamp into the venue step, where it suppressed the question forever while
    // the 48h clock kept running — cancelled at a step they were never asked about.
    const askedDuringScheduling = new Date(DAY_TIME.getTime() - 40 * 60 * 60_000);
    const venueOpened = new Date(DAY_TIME.getTime() - STALL_CHECK_IN_MS - 60_000);
    routeFindMany({
      stall: [
        makeVenueMatch({
          venuePromptAskedAt: venueOpened,
          stallCheckInSentAtA: askedDuringScheduling,
        }),
      ],
    });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(result.stallCheckIns).toBe(1);
  });

  it("does not re-ask when the stamp belongs to the phase in progress", async () => {
    const venueOpened = new Date(DAY_TIME.getTime() - STALL_CHECK_IN_MS - 60_000);
    routeFindMany({
      stall: [
        makeVenueMatch({
          venuePromptAskedAt: venueOpened,
          stallCheckInSentAtA: new Date(venueOpened.getTime() + 60_000),
        }),
      ],
    });
    const api = createMockApi();

    expect((await matchNudgeTick(api, { now: DAY_TIME })).stallCheckIns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The app rail (§4.3, the shape §5.4 established on the safety brief).
//
// All three reminder cadences used to collect their recipients with
// `telegramId > 0n` and then send a DM and nothing else — one filter answering
// two different questions. The predicates deciding WHO is owed a reminder
// (`acceptedBy*`, `schedulingOwedKind`) are unchanged; `platform` decides which
// rail carries it, and both are attempted.
//
// These route `findMany` by each query's own filters rather than by call order:
// five queries run per tick, and an order-dependent chain silently re-points at
// a different branch the next time a handler is added.
// ---------------------------------------------------------------------------

function routeQueries(rows: {
  proposal?: unknown[];
  scheduling?: unknown[];
  deadline?: unknown[];
  venue?: unknown[];
}) {
  (prisma.match.findMany as ReturnType<typeof vi.fn>).mockImplementation(
    (args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      const status = where.status;
      if (status === "negotiating") return Promise.resolve(rows.scheduling ?? []);
      if (status === "negotiating_venue") return Promise.resolve(rows.venue ?? []);
      if (status === "proposed") {
        // The deadline sweep is the only `proposed` query filtering on its own
        // stamp; the 3h/10h cadence filters on `proposalNudge2SentAt`.
        return Promise.resolve(
          "proposalDeadlineNudgeSentAt" in where ? (rows.deadline ?? []) : (rows.proposal ?? []),
        );
      }
      return Promise.resolve([]); // the stall chain: not this slice
    },
  );
}

/** A participant with an explicit rail. `theme` is read only by the calendar CTA. */
function railUser(id: string, telegramId: bigint, platform: string | null, name: string) {
  return { id, telegramId, platform, language: "en", firstName: name, theme: "dark" };
}
type RailUser = ReturnType<typeof railUser>;

// Dispatched so ~90 minutes remain: inside [TTL - lead, TTL).
const DEADLINE_DISPATCH = new Date(
  DAY_TIME.getTime() - (TTL_MS - PROPOSAL_DEADLINE_NUDGE_LEAD_MS) - 30 * 60_000,
);

interface RailCadence {
  name: string;
  matchId: string;
  counter: "proposalNudges" | "schedNudges" | "deadlineNudges";
  pushType: string;
  stampField: string;
  /**
   * Does the idempotency claim run BEFORE the recipient list is built? The two
   * proposal-phase cadences claim first and therefore stamp even when nobody is
   * reachable (so the row is not re-evaluated every tick); the planning cadence
   * builds `owing` first and skips the claim entirely. Both orderings are
   * pre-existing and neither moved with the rails.
   */
  stampsWithNoReachableRecipient: boolean;
  route: (a: RailUser, b: RailUser) => void;
}

const RAIL_CADENCES: RailCadence[] = [
  {
    name: "decision reminder (3h/10h)",
    matchId: "match-1",
    counter: "proposalNudges",
    pushType: MATCH_NUDGE_PUSH_TYPE,
    stampField: "proposalNudge1SentAt",
    stampsWithNoReachableRecipient: true,
    route: (userA, userB) =>
      routeQueries({ proposal: [makeProposedMatch({ userA, userB })] }),
  },
  {
    name: "planning reminder (6h/12h)",
    matchId: "match-2",
    counter: "schedNudges",
    pushType: PLANNING_NUDGE_PUSH_TYPE,
    stampField: "schedNudge1SentAt",
    stampsWithNoReachableRecipient: false,
    route: (userA, userB) =>
      routeQueries({ scheduling: [makeNegotiatingMatch({ userA, userB })] }),
  },
  {
    name: "deadline heads-up (~2h out)",
    matchId: "match-1",
    counter: "deadlineNudges",
    pushType: DEADLINE_NUDGE_PUSH_TYPE,
    stampField: "proposalDeadlineNudgeSentAt",
    stampsWithNoReachableRecipient: true,
    route: (userA, userB) =>
      routeQueries({
        deadline: [
          makeProposedMatch({
            dispatchedAt: DEADLINE_DISPATCH,
            proposalDeadlineNudgeSentAt: null,
            userA,
            userB,
          }),
        ],
      }),
  },
];

describe.each(RAIL_CADENCES)("matchNudgeTick — $name reaches both surfaces", (cadence) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TICKET_FEATURE_ENABLED = false;
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mPush.mockResolvedValue(true);
  });

  const run = (api: ReturnType<typeof createMockApi>) =>
    matchNudgeTick(api, {
      fetchFn: vi.fn().mockResolvedValue(openaiOk("A short nudge.")),
      now: DAY_TIME,
    });

  // A REAL positive id on an app-only account is the case an id-based filter
  // gets wrong while reporting success (§1.1). `platform` is the only answer.
  it("pushes to a recipient living in the app, and sends them no DM", async () => {
    cadence.route(
      railUser("she", 424242n, "mobile", "Carol"),
      railUser("him", 12n, "telegram", "Dan"),
    );
    const api = createMockApi();

    const result = await run(api);

    expect(mPush).toHaveBeenCalledTimes(1);
    expect(mPush.mock.calls[0][0]).toBe("she");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(12);
    expect(result[cadence.counter]).toBe(2);
  });

  // The ORDINARY mobile shape — a synthetic negative id (ARCHITECTURE →
  // `users`) — as opposed to the Telegram-login case above. Both must reach the
  // app, and only a `platform` test gets both right: any id-based filter, old
  // (`telegramId > 0n`) or shared (`stallReachableFor`), drops this one.
  it("pushes to a mobile account carrying a synthetic negative id", async () => {
    cadence.route(
      railUser("she", -7n, "mobile", "Carol"),
      railUser("him", 12n, "telegram", "Dan"),
    );
    const api = createMockApi();

    const result = await run(api);

    expect(mPush).toHaveBeenCalledTimes(1);
    expect(mPush.mock.calls[0][0]).toBe("she");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(result[cadence.counter]).toBe(2);
  });

  it("sends only a DM to a recipient on Telegram", async () => {
    cadence.route(
      railUser("she", 11n, "telegram", "Carol"),
      railUser("him", 12n, "telegram", "Dan"),
    );
    const api = createMockApi();

    const result = await run(api);

    expect(mPush).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(result[cadence.counter]).toBe(2);
  });

  // The counter is denominated in people, not messages: a `both` recipient is
  // one reminder delivered twice. Counting legs would double them and stop the
  // daily figure comparing with the days before this change.
  it("carries both rails for a `both` account, and still counts one person", async () => {
    cadence.route(
      railUser("she", 11n, "both", "Carol"),
      railUser("him", 12n, "telegram", "Dan"),
    );
    const api = createMockApi();

    const result = await run(api);

    expect(mPush).toHaveBeenCalledTimes(1);
    expect(mPush.mock.calls[0][0]).toBe("she");
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(result[cadence.counter]).toBe(2);
  });

  // A row predating the `platform` column: the id is the fallback, so no
  // existing Telegram user loses anything.
  it("still DMs a row with no platform and a positive id", async () => {
    cadence.route(
      railUser("she", 11n, null, "Carol"),
      railUser("him", 12n, null, "Dan"),
    );
    const api = createMockApi();

    const result = await run(api);

    expect(mPush).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(result[cadence.counter]).toBe(2);
  });

  it("says nothing at all when neither rail reaches anybody", async () => {
    cadence.route(
      railUser("she", -11n, null, "Carol"),
      railUser("him", -12n, null, "Dan"),
    );
    const api = createMockApi();

    const result = await run(api);

    expect(mPush).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result[cadence.counter]).toBe(0);

    // The deliberate asymmetry, pinned so a future edit has to mean it.
    if (cadence.stampsWithNoReachableRecipient) {
      expect(prisma.match.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { [cadence.stampField]: DAY_TIME } }),
      );
    } else {
      expect(prisma.match.updateMany).not.toHaveBeenCalled();
    }
  });

  it("a failed push takes neither the DM nor the idempotency stamp", async () => {
    cadence.route(
      railUser("she", 11n, "both", "Carol"),
      railUser("him", 12n, "telegram", "Dan"),
    );
    mPush.mockRejectedValue(new Error("APNs unavailable"));
    const api = createMockApi();

    const result = await run(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { [cadence.stampField]: DAY_TIME } }),
    );
    expect(result[cadence.counter]).toBe(2); // her DM still landed
  });

  it("a failed DM takes neither the push nor the idempotency stamp", async () => {
    cadence.route(
      railUser("she", 11n, "both", "Carol"),
      railUser("him", 12n, "telegram", "Dan"),
    );
    const api = createMockApi();
    api.sendMessage.mockRejectedValue(new Error("403 Forbidden: bot was blocked"));

    const result = await run(api);

    expect(mPush).toHaveBeenCalledTimes(1);
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { [cadence.stampField]: DAY_TIME } }),
    );
    // She was still reached, by push. He was not reached at all.
    expect(result[cadence.counter]).toBe(1);
  });

  // `sendPushToUser` resolves false — no token registered, APNs unconfigured,
  // APNs refused. Nothing was delivered, so nobody was reminded.
  it("does not count a push that never landed", async () => {
    cadence.route(
      railUser("she", 424242n, "mobile", "Carol"),
      railUser("him", 12n, "telegram", "Dan"),
    );
    mPush.mockResolvedValue(false);
    const api = createMockApi();

    const result = await run(api);

    expect(mPush).toHaveBeenCalledTimes(1);
    expect(result[cadence.counter]).toBe(1); // his DM only
  });

  it("carries the frozen type and payload the client routes on", async () => {
    cadence.route(
      railUser("she", 424242n, "mobile", "Carol"),
      railUser("him", 12n, "telegram", "Dan"),
    );
    const api = createMockApi();

    await run(api);

    const payload = mPush.mock.calls[0][1] as {
      title: string;
      body: string;
      data: Record<string, unknown>;
      collapseId?: string;
    };
    expect(payload.data).toEqual({ type: cadence.pushType, matchId: cadence.matchId });
    expect(payload.title.length).toBeGreaterThan(0);
    expect(payload.body.length).toBeGreaterThan(0);
    // No action buttons and no collapse key: these are ordinary notifications
    // whose next step is "open the app".
    expect(payload.collapseId).toBeUndefined();
  });
});

describe("matchNudgeTick — rails, the cases that are not per-cadence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TICKET_FEATURE_ENABLED = false;
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mPush.mockResolvedValue(true);
  });

  // Quiet hours are about the person, not the transport. None of these three
  // types is time-sensitive, so none of them has any claim on someone's night.
  it("quiet hours silence the pushes too, not just the DMs", async () => {
    routeQueries({
      proposal: [
        makeProposedMatch({
          userA: railUser("she", 424242n, "mobile", "Carol"),
          userB: railUser("him", 12n, "mobile", "Dan"),
        }),
      ],
      scheduling: [
        makeNegotiatingMatch({
          userA: railUser("her", 3n, "mobile", "Eve"),
          userB: railUser("his", 4n, "mobile", "Frank"),
        }),
      ],
      deadline: [
        makeProposedMatch({
          dispatchedAt: DEADLINE_DISPATCH,
          proposalDeadlineNudgeSentAt: null,
          userA: railUser("x", 5n, "mobile", "Gina"),
          userB: railUser("y", 6n, "mobile", "Hank"),
        }),
      ],
    });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: QUIET_TIME });

    expect(mPush).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(prisma.match.findMany).not.toHaveBeenCalled();
    expect(result.proposalNudges + result.schedNudges + result.deadlineNudges).toBe(0);
  });

  // The push copy has to be true in BOTH planning branches — the calendar was
  // never opened, and both picked with nothing overlapping — so there is one
  // string, and it says "open the calendar" rather than "pick a time".
  it("pushes the same planning copy when both picked and nothing overlaps", async () => {
    routeQueries({
      scheduling: [
        makeNegotiatingMatch({
          availableTimesA: [SCHED_SLOT],
          availableTimesB: [SCHED_SLOT_2],
          userA: railUser("she", 424242n, "mobile", "Carol"),
          userB: railUser("him", 12n, "telegram", "Dan"),
        }),
      ],
    });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { fetchFn: vi.fn(), now: DAY_TIME });

    expect(result.schedNudges).toBe(2);
    expect(mPush).toHaveBeenCalledTimes(1);
    expect(mPush.mock.calls[0][1]).toMatchObject({
      title: t("en", "planningNudgePushTitle"),
      body: t("en", "planningNudgePushBody"),
      data: { type: PLANNING_NUDGE_PUSH_TYPE },
    });
    // The DM branch is unchanged: static copy plus the way back into the grid.
    expect(api.sendMessage).toHaveBeenCalledWith(
      12,
      t("en", "matchScheduleNoOverlapYet"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  // One deadline, one figure. A push and a DM disagreeing about how long is
  // left is worse than either of them alone.
  it("quotes the deadline push the same number of hours as the DM", async () => {
    routeQueries({
      deadline: [
        makeProposedMatch({
          dispatchedAt: DEADLINE_DISPATCH,
          proposalDeadlineNudgeSentAt: null,
          userA: railUser("she", 11n, "both", "Carol"),
          userB: railUser("him", 12n, "telegram", "Dan"),
        }),
      ],
    });
    const api = createMockApi();

    await matchNudgeTick(api, { now: DAY_TIME });

    const dm = api.sendMessage.mock.calls[0][1] as string;
    const hours = Number(/(\d+)/.exec(dm)?.[1]);
    expect(hours).toBeGreaterThan(0);
    expect(dm).toBe(t("en", "pitchDeadlineNudge", { hours }));
    expect((mPush.mock.calls[0][1] as { body: string }).body).toBe(
      t("en", "deadlineNudgePushBody", { hours }),
    );
  });

  it("speaks each recipient's own language on both rails", async () => {
    routeQueries({
      proposal: [
        makeProposedMatch({
          userA: { ...railUser("she", 424242n, "mobile", "Carol"), language: "uk" },
          userB: { ...railUser("him", 12n, "mobile", "Dan"), language: "de" },
        }),
      ],
    });
    const api = createMockApi();

    await matchNudgeTick(api, {
      fetchFn: vi.fn().mockResolvedValue(openaiOk("nudge")),
      now: DAY_TIME,
    });

    const bodies = mPush.mock.calls.map((c) => (c[1] as { body: string }).body);
    expect(bodies).toContain(t("uk", "matchNudgePushBody"));
    expect(bodies).toContain(t("de", "matchNudgePushBody"));
  });

  // Boundary guard, and it pins two things at once. `stallReachableFor` is
  // SHARED with the venue nudge, the check-in and the cancellation, where
  // `telegramId > 0n` is the RIGHT test — that chain is an inline keyboard an
  // app user has nothing to answer with. So the venue step is deliberately
  // untouched by this slice: it still gains no push rail, and it still decides
  // on the id's sign, which for this fixture (a `mobile` account carrying a real
  // positive id) means it still sends the DM it always sent. Swapping that
  // helper for `telegramReachable` while adding rails here would silently start
  // cancelling matches on people who were never asked.
  it("leaves the venue step on its own predicate — no push rail, no rewrite", async () => {
    routeQueries({
      venue: [makeVenueMatch({ userA: railUser("she", 424242n, "mobile", "Alice") })],
    });
    const api = createMockApi();

    const result = await matchNudgeTick(api, { now: DAY_TIME });

    expect(mPush).not.toHaveBeenCalled();
    expect(result.venueNudges).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(424242);
  });
});
