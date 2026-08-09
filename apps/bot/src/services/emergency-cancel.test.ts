import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindUnique = vi.fn();
const matchUpdateMany = vi.fn();
const userFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique, updateMany: matchUpdateMany },
    user: { findUnique: userFindUnique },
  },
}));

const applyEmergencyCancellationPeerBoost = vi.fn();
vi.mock("../utils/elo-calculator.js", () => ({ applyEmergencyCancellationPeerBoost }));

const sendPushToUser = vi.fn();
vi.mock("./push.js", () => ({ sendPushToUser }));

const refundMatchTickets = vi.fn();
vi.mock("./ticket-refund.js", () => ({ refundMatchTickets }));

const getMainBotApi = vi.fn((): unknown => null);
vi.mock("./main-bot-api.js", () => ({ getMainBotApi }));

const refreshStatusBanners = vi.fn();
vi.mock("./status-banner-refresh.js", () => ({ refreshStatusBanners }));

const { cancelScheduledDate } = await import("./emergency-cancel.js");

const ACTOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function scheduledRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    status: "scheduled",
    userAId: ACTOR,
    userBId: PEER,
    emergencyCancelledBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  matchFindUnique.mockReset();
  matchUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  userFindUnique.mockReset().mockResolvedValue({ language: "ru" });
  applyEmergencyCancellationPeerBoost.mockReset().mockResolvedValue(505);
  sendPushToUser.mockReset().mockResolvedValue(true);
  refundMatchTickets.mockReset().mockResolvedValue([
    { userId: ACTOR, refunded: 1 },
    { userId: PEER, refunded: 1 },
  ]);
  getMainBotApi.mockReset().mockReturnValue(null);
  refreshStatusBanners.mockReset().mockResolvedValue(undefined);
});

describe("cancelScheduledDate", () => {
  it("cancels, boosts the peer and refunds BOTH sides", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow());

    const result = await cancelScheduledDate({
      matchId: "m1",
      actorUserId: ACTOR,
      reason: "  Сорри, заболел  ",
    });

    expect(result).toEqual({
      ok: true,
      outcome: {
        peerUserId: PEER,
        reason: "Сорри, заболел",
        refunds: [
          { userId: ACTOR, refunded: 1 },
          { userId: PEER, refunded: 1 },
        ],
      },
    });
    expect(applyEmergencyCancellationPeerBoost).toHaveBeenCalledWith(PEER);
    // The canceller is refunded too — charging them on top of the Elo penalty
    // would make an honest cancellation cost more than a silent no-show.
    expect(refundMatchTickets).toHaveBeenCalledWith("m1");
  });

  it("claims the row with a compare-and-set so a race cancels once", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow());
    matchUpdateMany.mockResolvedValue({ count: 0 });

    const result = await cancelScheduledDate({
      matchId: "m1",
      actorUserId: ACTOR,
      reason: "нет",
    });

    expect(result).toEqual({ ok: false, error: "wrong-state" });
    // Nothing downstream may run for the loser of the race.
    expect(refundMatchTickets).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(refreshStatusBanners).not.toHaveBeenCalled();
  });

  it("pushes the pinned banner back to the drop countdown for both sides", async () => {
    // The date it was counting down to no longer exists — pushed now rather
    // than left naming a cancelled date for up to a minute. Shared by BOTH
    // surfaces (Telegram + the native /v1/matches/{id}/cancel rail), which is
    // exactly why this lives here via the process-wide bot handle rather than
    // in either caller.
    const api = { editMessageText: vi.fn() };
    getMainBotApi.mockReturnValue(api);
    matchFindUnique.mockResolvedValue(scheduledRow());

    await cancelScheduledDate({ matchId: "m1", actorUserId: ACTOR, reason: "x" });

    expect(refreshStatusBanners).toHaveBeenCalledWith(api, [ACTOR, PEER]);
  });

  it("never throws when the bot has not finished booting (getMainBotApi() is null)", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow());

    const result = await cancelScheduledDate({
      matchId: "m1",
      actorUserId: ACTOR,
      reason: "x",
    });

    expect(result.ok).toBe(true);
    expect(refreshStatusBanners).not.toHaveBeenCalled();
  });

  it("pushes the partner without carrying the reason onto their lock screen", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow());

    await cancelScheduledDate({
      matchId: "m1",
      actorUserId: ACTOR,
      reason: "секретная причина",
    });

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const [userId, payload] = sendPushToUser.mock.calls[0]!;
    expect(userId).toBe(PEER);
    expect(payload.data).toEqual({ type: "match.cancelled", matchId: "m1" });
    expect(`${payload.title} ${payload.body}`).not.toContain("секретная");
  });

  it("refuses a non-participant", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow());
    await expect(
      cancelScheduledDate({ matchId: "m1", actorUserId: "someone-else", reason: "x" }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a match that is not a scheduled date", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow({ status: "negotiating" }));
    await expect(
      cancelScheduledDate({ matchId: "m1", actorUserId: ACTOR, reason: "x" }),
    ).resolves.toEqual({ ok: false, error: "wrong-state" });
  });

  it("refuses a date already cancelled by the other side", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow({ emergencyCancelledBy: PEER }));
    await expect(
      cancelScheduledDate({ matchId: "m1", actorUserId: ACTOR, reason: "x" }),
    ).resolves.toEqual({ ok: false, error: "wrong-state" });
  });

  it("still cancels when the refund rail throws", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow());
    refundMatchTickets.mockRejectedValue(new Error("ledger down"));

    const result = await cancelScheduledDate({
      matchId: "m1",
      actorUserId: ACTOR,
      reason: "x",
    });

    expect(result.ok).toBe(true);
    // The row is already cancelled at this point; unwinding it because a
    // refund failed would leave a date on that both sides believe is off.
    expect(matchUpdateMany).toHaveBeenCalled();
  });

  it("caps the forwarded reason at the same length as the Telegram rail", async () => {
    matchFindUnique.mockResolvedValue(scheduledRow());
    const result = await cancelScheduledDate({
      matchId: "m1",
      actorUserId: ACTOR,
      reason: "я".repeat(1500),
    });
    expect(result.ok && result.outcome.reason.length).toBe(1000);
  });
});
