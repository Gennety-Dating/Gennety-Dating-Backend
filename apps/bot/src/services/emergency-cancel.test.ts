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

const refundPrimeTimeForDeadMatch = vi.fn();
vi.mock("./prime-time-purchase.js", () => ({ refundPrimeTimeForDeadMatch }));

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
    agreedTime: new Date(Date.now() + 3 * 60 * 60 * 1000),
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
  refundPrimeTimeForDeadMatch.mockReset().mockResolvedValue(undefined);
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

  /**
   * Founder decision 2026-09-26: a scheduled date can be cancelled at ANY
   * point before it starts. `DATE_ALERT_HOURS` (T-5h) only times the
   * ice-breaker message and its reminder button — it was never a gate here,
   * and this pins that it never becomes one. Every consequence runs unchanged
   * however early the cancel is: the peer's boost, both ticket refunds, the
   * Prime Time refund, the partner's push.
   */
  it.each([
    ["T-24h", 24],
    ["T-6h", 6],
    ["T-2h", 2],
  ])("cancels at %s with every consequence settled", async (_label, hoursBefore) => {
    const now = new Date("2026-10-01T12:00:00Z");
    const agreedTime = new Date(now.getTime() + hoursBefore * 60 * 60 * 1000);
    matchFindUnique.mockResolvedValue(scheduledRow({ agreedTime }));

    const result = await cancelScheduledDate({ matchId: "m1", actorUserId: ACTOR, reason: "x", now });

    expect(result.ok).toBe(true);
    expect(matchUpdateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: "scheduled", emergencyCancelledBy: null, agreedTime: { gt: now } },
      data: { status: "cancelled", emergencyCancelledBy: ACTOR, emergencyReason: "x" },
    });
    expect(applyEmergencyCancellationPeerBoost).toHaveBeenCalledWith(PEER);
    expect(refundMatchTickets).toHaveBeenCalledWith("m1");
    expect(refundPrimeTimeForDeadMatch).toHaveBeenCalledWith("m1");
    expect(sendPushToUser).toHaveBeenCalledWith(PEER, expect.anything());
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

  // A13-M20. A `scheduled` row stays scheduled until the T+24h feedback prompt,
  // so the cancel used to refund both tickets for a date that had happened.
  it("refuses once the agreed time has come — nothing is cancelled or refunded", async () => {
    const now = new Date("2026-04-10T19:00:00Z");
    matchFindUnique.mockResolvedValue(scheduledRow({ agreedTime: now }));

    const result = await cancelScheduledDate({ matchId: "m1", actorUserId: ACTOR, reason: "x", now });

    expect(result).toEqual({ ok: false, error: "date-started" });
    expect(matchUpdateMany).not.toHaveBeenCalled();
    expect(refundMatchTickets).not.toHaveBeenCalled();
    expect(applyEmergencyCancellationPeerBoost).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("carries the start cut-off into the compare-and-set", async () => {
    const now = new Date("2026-04-10T12:00:00Z");
    matchFindUnique.mockResolvedValue(
      scheduledRow({ agreedTime: new Date("2026-04-10T19:00:00Z") }),
    );

    await cancelScheduledDate({ matchId: "m1", actorUserId: ACTOR, reason: "x", now });

    expect(matchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1", status: "scheduled", emergencyCancelledBy: null, agreedTime: { gt: now } },
      }),
    );
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
