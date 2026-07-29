import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: vi.fn(), updateMany: vi.fn() },
    profile: { update: vi.fn() },
  },
}));

vi.mock("../utils/elo-calculator.js", () => ({
  applySilentIgnorePenalty: vi.fn().mockResolvedValue(495),
}));

vi.mock("./match-decision-shared.js", () => ({
  boostAcceptedSidePriority: vi.fn().mockResolvedValue(true),
}));

// Wiring only — the refund semantics live in ticket-refund.test.ts.
vi.mock("./ticket-refund.js", async () => {
  const actual = await import("./ticket-refund.js");
  return {
    refundMatchTickets: vi.fn().mockResolvedValue([]),
    ticketRefundNoticeKey: actual.ticketRefundNoticeKey,
  };
});

import { prisma } from "@gennety/db";
import { applySilentIgnorePenalty } from "../utils/elo-calculator.js";
import { boostAcceptedSidePriority } from "./match-decision-shared.js";
import { refundMatchTickets } from "./ticket-refund.js";
import {
  STALL_CHECK_IN_MS,
  STALL_TIMEOUT_MS,
  cancelPlanningByUser,
  cancelStalledMatch,
  sideOwesAction,
  stallBaseFor,
  stallCheckInDueAt,
  stallDeadlineAt,
  stallPhaseOf,
  stallReachableFor,
  type StallMatchRow,
} from "./match-stall.js";

const NOW = new Date("2026-07-29T12:00:00Z");
const SLOT = new Date("2026-08-01T16:00:00Z");

/** A scheduling-phase row: Calendar open, neither side has marked anything. */
function schedulingRow(overrides: Partial<StallMatchRow> = {}): StallMatchRow {
  return {
    status: "negotiating",
    dispatchedAt: new Date(NOW.getTime() - 40 * 60 * 60 * 1000),
    schedulingOpenedAt: new Date(NOW.getTime() - 30 * 60 * 60 * 1000),
    venuePromptAskedAt: null,
    proposedTimes: [SLOT],
    availableTimesA: [],
    availableTimesB: [],
    vibeTextA: null,
    vibeLatA: null,
    vibeLngA: null,
    vibeTextB: null,
    vibeLatB: null,
    vibeLngB: null,
    stallConfirmedAtA: null,
    stallConfirmedAtB: null,
    ...overrides,
  };
}

/** A venue-phase row: A has submitted point + vibe, B has not. */
function venueRow(overrides: Partial<StallMatchRow> = {}): StallMatchRow {
  return {
    ...schedulingRow(),
    status: "negotiating_venue",
    proposedTimes: [SLOT],
    availableTimesA: [SLOT],
    availableTimesB: [SLOT],
    venuePromptAskedAt: new Date(NOW.getTime() - 30 * 60 * 60 * 1000),
    vibeTextA: "quiet cafe",
    vibeLatA: 50.45,
    vibeLngA: 30.52,
    ...overrides,
  };
}

describe("stallPhaseOf", () => {
  it("reads the venue phase from the status", () => {
    expect(stallPhaseOf(venueRow())).toBe("venue");
  });

  it("reads the scheduling phase only once the Calendar has slots", () => {
    expect(stallPhaseOf(schedulingRow())).toBe("scheduling");
  });

  it("is null while the Date Ticket gate is open (negotiating, no slots yet)", () => {
    // The gate has its own deadline, refund policy and expiry worker. Treating
    // it as a stall would double-own that wait and could cancel a match over
    // an unpaid ticket.
    expect(stallPhaseOf(schedulingRow({ proposedTimes: [] }))).toBeNull();
  });

  it("is null for a booked date", () => {
    expect(stallPhaseOf({ status: "scheduled", proposedTimes: [SLOT] })).toBeNull();
  });
});

describe("sideOwesAction", () => {
  it("scheduling: a side owes until it marks availability", () => {
    const row = schedulingRow({ availableTimesA: [SLOT] });
    expect(sideOwesAction(row, "A")).toBe(false);
    expect(sideOwesAction(row, "B")).toBe(true);
  });

  it("venue: a complete submission needs BOTH the point and the vibe", () => {
    expect(sideOwesAction(venueRow(), "A")).toBe(false);
    expect(sideOwesAction(venueRow(), "B")).toBe(true);
    // Point but no vibe.
    expect(
      sideOwesAction(venueRow({ vibeTextA: null }), "A"),
    ).toBe(true);
    // Vibe but no point.
    expect(
      sideOwesAction(venueRow({ vibeLatA: null, vibeLngA: null }), "A"),
    ).toBe(true);
  });

  it("nobody owes anything outside the two planning phases", () => {
    expect(sideOwesAction(schedulingRow({ proposedTimes: [] }), "A")).toBe(false);
  });
});

describe("stall timing", () => {
  it("counts from the phase anchor, not from dispatch", () => {
    const row = schedulingRow();
    expect(stallBaseFor(row, "A")).toEqual(row.schedulingOpenedAt);
    expect(stallCheckInDueAt(row, "A")).toEqual(
      new Date(row.schedulingOpenedAt!.getTime() + STALL_CHECK_IN_MS),
    );
    expect(stallDeadlineAt(row, "A")).toEqual(
      new Date(row.schedulingOpenedAt!.getTime() + STALL_TIMEOUT_MS),
    );
  });

  it("falls back to dispatch for rows predating schedulingOpenedAt", () => {
    const row = schedulingRow({ schedulingOpenedAt: null });
    expect(stallBaseFor(row, "A")).toEqual(row.dispatchedAt);
  });

  it("uses venuePromptAskedAt for the venue phase", () => {
    const row = venueRow();
    expect(stallBaseFor(row, "B")).toEqual(row.venuePromptAskedAt);
  });

  it("a green tap pushes that side's deadline out, and only that side's", () => {
    const confirmed = new Date(NOW.getTime() - 60_000);
    const row = schedulingRow({ stallConfirmedAtA: confirmed });
    expect(stallDeadlineAt(row, "A")).toEqual(
      new Date(confirmed.getTime() + STALL_TIMEOUT_MS),
    );
    expect(stallDeadlineAt(row, "B")).toEqual(
      new Date(row.schedulingOpenedAt!.getTime() + STALL_TIMEOUT_MS),
    );
  });

  it("ignores a confirmation older than the anchor", () => {
    const row = venueRow({
      stallConfirmedAtB: new Date(NOW.getTime() - 100 * 60 * 60 * 1000),
    });
    expect(stallBaseFor(row, "B")).toEqual(row.venuePromptAskedAt);
  });

  it("has no timing at all without an anchor", () => {
    const row = venueRow({ venuePromptAskedAt: null });
    expect(stallBaseFor(row, "A")).toBeNull();
    expect(stallDeadlineAt(row, "A")).toBeNull();
    expect(stallCheckInDueAt(row, "A")).toBeNull();
  });
});

describe("stallReachableFor", () => {
  it("excludes the synthetic negative ids mobile-only accounts carry", () => {
    expect(stallReachableFor(123n)).toBe(true);
    expect(stallReachableFor(-123n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    ...venueRow(),
    id: "match-1",
    userAId: "user-a",
    userBId: "user-b",
    venueNudge1SentAt: null,
    venueNudge2SentAt: null,
    stallCheckInSentAtA: null,
    stallCheckInSentAtB: null,
    userA: {
      id: "user-a",
      telegramId: 11n,
      language: "en",
      firstName: "Alice",
      theme: "dark",
    },
    userB: {
      id: "user-b",
      telegramId: 12n,
      language: "en",
      firstName: "Bob",
      theme: "dark",
    },
    ...overrides,
  };
}

function mockApi() {
  return { sendMessage: vi.fn().mockResolvedValue({}) } as never;
}

describe("cancelStalledMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      silentIgnoreCount: 1,
    });
  });

  it("cancels, penalises only the silent side, and compensates the other", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    const api = mockApi();

    const result = await cancelStalledMatch(api, "match-1", NOW);

    expect(result.cancelled).toBe(true);
    expect(result.ghostUserIds).toEqual(["user-b"]);
    expect(result.waitingUserIds).toEqual(["user-a"]);

    // The CAS asserts the phase's own status, so a concurrent transition loses.
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1", status: "negotiating_venue" },
        data: { status: "cancelled" },
      }),
    );
    expect(prisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-b" } }),
    );
    expect(boostAcceptedSidePriority).toHaveBeenCalledWith("user-a");
    expect(boostAcceptedSidePriority).toHaveBeenCalledTimes(1);
  });

  it("forgives the first silent ignore and penalises the next", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());

    await cancelStalledMatch(mockApi(), "match-1", NOW);
    expect(applySilentIgnorePenalty).not.toHaveBeenCalled();

    vi.clearAllMocks();
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      silentIgnoreCount: 2,
    });

    await cancelStalledMatch(mockApi(), "match-1", NOW);
    expect(applySilentIgnorePenalty).toHaveBeenCalledWith("user-b");
  });

  it("tells each side what actually happened", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    const api = mockApi() as unknown as { sendMessage: ReturnType<typeof vi.fn> };

    await cancelStalledMatch(api as never, "match-1", NOW);

    const byChat = new Map(
      api.sendMessage.mock.calls.map((c) => [Number(c[0]), String(c[1])]),
    );
    // The one who did their part hears that the partner never answered.
    expect(byChat.get(11)).toContain("Bob never got back to us");
    // The silent one hears why it lapsed, and that saying so is fine next time.
    expect(byChat.get(12)).toContain("no answer for two days");
  });

  it("never cancels over a side that could not have answered", async () => {
    // Mobile-only B (synthetic negative id) has no inline keyboard to tap.
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      dbRow({ userB: { ...dbRow().userB, telegramId: -12n } }),
    );

    const result = await cancelStalledMatch(mockApi(), "match-1", NOW);

    expect(result.cancelled).toBe(false);
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });

  it("is a no-op when both sides have submitted", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      dbRow({ vibeTextB: "park walk", vibeLatB: 50.4, vibeLngB: 30.5 }),
    );

    const result = await cancelStalledMatch(mockApi(), "match-1", NOW);

    expect(result.cancelled).toBe(false);
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });

  it("applies no side effects when the status CAS loses the race", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

    const result = await cancelStalledMatch(mockApi(), "match-1", NOW);

    expect(result.cancelled).toBe(false);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(boostAcceptedSidePriority).not.toHaveBeenCalled();
  });

  it("ignores a match that is no longer in a planning phase", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      dbRow({ status: "scheduled" }),
    );

    expect((await cancelStalledMatch(mockApi(), "match-1", NOW)).cancelled).toBe(false);
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });
});

describe("cancelPlanningByUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  });

  it("cancels with no penalty for the person who said so", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    const api = mockApi() as unknown as { sendMessage: ReturnType<typeof vi.fn> };

    const result = await cancelPlanningByUser(api as never, "match-1", "user-b");

    expect(result.cancelled).toBe(true);
    // Honest exit must stay cheaper than going quiet, or the button is pointless.
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(applySilentIgnorePenalty).not.toHaveBeenCalled();
    // The partner is compensated exactly as if they had been ghosted.
    expect(boostAcceptedSidePriority).toHaveBeenCalledWith("user-a");
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "cancelled", emergencyCancelledBy: "user-b" },
      }),
    );
  });

  it("names the partner to the actor and the actor to the partner", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    const api = mockApi() as unknown as { sendMessage: ReturnType<typeof vi.fn> };

    const result = await cancelPlanningByUser(api as never, "match-1", "user-b");

    expect(result.ackText).toContain("Alice");
    expect(Number(api.sendMessage.mock.calls[0][0])).toBe(11);
    expect(String(api.sendMessage.mock.calls[0][1])).toContain("Bob's plans changed");
  });
});



describe("cancelStalledMatch — ticket refunds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      silentIgnoreCount: 1,
    });
  });

  it("refunds the ghost too, and tells both sides (PRODUCT_SPEC §3.5b)", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: "user-a", refunded: 1, telegramId: 11n, language: "en", platform: "telegram" },
      { userId: "user-b", refunded: 1, telegramId: 22n, language: "en", platform: "telegram" },
    ]);
    const api = mockApi() as unknown as { sendMessage: ReturnType<typeof vi.fn> };

    await cancelStalledMatch(api as never, "match-1", NOW);

    expect(refundMatchTickets).toHaveBeenCalledWith("match-1");
    // Ghosting is priced in Elo above; taking the ticket on top would make
    // silence cost money that an honest "plans changed" does not.
    const bodies = api.sendMessage.mock.calls.map((c) => String(c[1]));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toContain("back in your wallet");
  });

  it("does not mention a wallet when no ticket was paid", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    const api = mockApi() as unknown as { sendMessage: ReturnType<typeof vi.fn> };

    await cancelStalledMatch(api as never, "match-1", NOW);

    for (const call of api.sendMessage.mock.calls) {
      expect(String(call[1])).not.toContain("wallet");
    }
  });

  it("still cancels when the refund throws", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("wallet down"));

    const result = await cancelStalledMatch(mockApi(), "match-1", NOW);

    expect(result.cancelled).toBe(true);
  });
});

describe("cancelPlanningByUser — ticket refunds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  });

  it("refunds the actor who took the honest exit and says so in the ack", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: "user-b", refunded: 2, telegramId: 22n, language: "en", platform: "telegram" },
    ]);
    const api = mockApi() as unknown as { sendMessage: ReturnType<typeof vi.fn> };

    const result = await cancelPlanningByUser(api as never, "match-1", "user-b");

    expect(refundMatchTickets).toHaveBeenCalledWith("match-1");
    // He covered both tickets and is ending it himself — both come back.
    expect(result.ackText).toContain("Both Date Tickets");
    // The partner paid nothing, so their notice stays refund-free.
    expect(String(api.sendMessage.mock.calls[0][1])).not.toContain("wallet");
  });

  it("tells the waiting partner when it was their ticket", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: "user-a", refunded: 1, telegramId: 11n, language: "en", platform: "telegram" },
    ]);
    const api = mockApi() as unknown as { sendMessage: ReturnType<typeof vi.fn> };

    const result = await cancelPlanningByUser(api as never, "match-1", "user-b");

    expect(String(api.sendMessage.mock.calls[0][1])).toContain("back in your wallet");
    expect(result.ackText).not.toContain("wallet");
  });
});

describe("cancelPlanningByUser (guards)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (refundMatchTickets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  });

  it("refuses a caller who is not in the match", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRow());

    const result = await cancelPlanningByUser(mockApi(), "match-1", "someone-else");

    expect(result.cancelled).toBe(false);
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });

  it("refuses once the match has left the planning phases", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      dbRow({ status: "cancelled" }),
    );

    const result = await cancelPlanningByUser(mockApi(), "match-1", "user-b");

    expect(result.cancelled).toBe(false);
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });
});
