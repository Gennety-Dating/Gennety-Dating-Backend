import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

const mockEnv = vi.hoisted(() => ({ TICKET_FEATURE_ENABLED: true }));
vi.mock("../config.js", () => ({ env: mockEnv }));

const startScheduling = vi.fn();
vi.mock("../handlers/matching/scheduler.js", () => ({
  startScheduling: (...a: unknown[]) => startScheduling(...a),
}));
const sendTicketOffer = vi.fn();
const GATE_DEADLINE = new Date("2026-10-14T12:00:00Z");
vi.mock("../handlers/matching/ticket-gate.js", () => ({
  sendTicketOffer: (...a: unknown[]) => sendTicketOffer(...a),
  ticketGateDeadline: () => GATE_DEADLINE,
}));
const updateEloScores = vi.fn();
vi.mock("../utils/elo-calculator.js", () => ({
  updateEloScores: (...a: unknown[]) => updateEloScores(...a),
}));
const sendPushToUser = vi.fn();
vi.mock("./push.js", () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }));
vi.mock("./status-banner-refresh.js", () => ({
  refreshStatusBanners: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import { STRANDED_HANDOFF_GRACE_MS } from "@gennety/shared";
import { recoverStrandedHandoffs } from "./stranded-handoff.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findMany: MockFn; updateMany: MockFn };
const mQueryRaw = (prisma as unknown as { $queryRaw: MockFn }).$queryRaw;
const api = {} as Parameters<typeof recoverStrandedHandoffs>[0];
const NOW = new Date("2026-10-13T12:00:00Z");

const mutualRow = {
  id: "m-mutual",
  userAId: "ua",
  userBId: "ub",
  userA: { id: "ua", platform: "telegram", language: "en" },
  userB: { id: "ub", platform: "mobile", language: "ru" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TICKET_FEATURE_ENABLED = true;
  mMatch.findMany.mockResolvedValue([]);
  mMatch.updateMany.mockResolvedValue({ count: 1 });
  mQueryRaw.mockResolvedValue([]);
  updateEloScores.mockResolvedValue(undefined);
  sendTicketOffer.mockResolvedValue(undefined);
  startScheduling.mockResolvedValue(undefined);
  sendPushToUser.mockResolvedValue(true);
});

describe("recoverStrandedHandoffs — mutual accept left in `proposed`", () => {
  it("only looks at rows both accepted, older than the grace window", async () => {
    await recoverStrandedHandoffs(api, NOW);

    expect(mMatch.findMany.mock.calls[0]![0].where).toEqual({
      status: "proposed",
      acceptedByA: true,
      acceptedByB: true,
      updatedAt: { lt: new Date(NOW.getTime() - STRANDED_HANDOFF_GRACE_MS) },
    });
  });

  it("flips it with the gate deadline armed, then sends the ticket offer once", async () => {
    mMatch.findMany.mockResolvedValueOnce([mutualRow]);

    const res = await recoverStrandedHandoffs(api, NOW);

    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "m-mutual", status: "proposed", acceptedByA: true, acceptedByB: true },
      data: { status: "negotiating", ticketExpiresAt: GATE_DEADLINE },
    });
    expect(updateEloScores).toHaveBeenCalledWith("ua", "ub", true, true);
    expect(sendTicketOffer).toHaveBeenCalledWith(api, "m-mutual");
    expect(startScheduling).not.toHaveBeenCalled();
    // Only the app user is pushed; the Telegram side got the ticket card.
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(sendPushToUser.mock.calls[0]![0]).toBe("ub");
    expect(res.mutualAccepts).toBe(1);
  });

  it("opens the calendar directly with tickets off", async () => {
    mockEnv.TICKET_FEATURE_ENABLED = false;
    mMatch.findMany.mockResolvedValueOnce([mutualRow]);

    await recoverStrandedHandoffs(api, NOW);

    expect(mMatch.updateMany.mock.calls[0]![0].data).toEqual({ status: "negotiating" });
    expect(startScheduling).toHaveBeenCalledWith(api, "m-mutual");
    expect(sendTicketOffer).not.toHaveBeenCalled();
  });

  it("does nothing when the original handoff finished in the meantime", async () => {
    mMatch.findMany.mockResolvedValueOnce([mutualRow]);
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await recoverStrandedHandoffs(api, NOW);

    expect(updateEloScores).not.toHaveBeenCalled();
    expect(sendTicketOffer).not.toHaveBeenCalled();
    expect(res.mutualAccepts).toBe(0);
  });
});

describe("recoverStrandedHandoffs — `negotiating` with no grid and no live gate", () => {
  it("opens the calendar after a terminal gate, as the post-gate card", async () => {
    mQueryRaw.mockResolvedValueOnce([
      { id: "m-done", ticket_status: "completed" },
      { id: "m-free", ticket_status: "pending" },
    ]);

    const res = await recoverStrandedHandoffs(api, NOW);

    expect(startScheduling).toHaveBeenCalledWith(api, "m-done", { afterTicketGate: true });
    expect(startScheduling).toHaveBeenCalledWith(api, "m-free", { afterTicketGate: false });
    expect(res.calendarsOpened).toBe(2);
  });

  it("keeps going when one row fails", async () => {
    mQueryRaw.mockResolvedValueOnce([
      { id: "bad", ticket_status: "expired" },
      { id: "good", ticket_status: "refunded" },
    ]);
    startScheduling.mockRejectedValueOnce(new Error("telegram down"));

    const res = await recoverStrandedHandoffs(api, NOW);

    expect(startScheduling).toHaveBeenCalledTimes(2);
    expect(res.calendarsOpened).toBe(1);
  });
});
