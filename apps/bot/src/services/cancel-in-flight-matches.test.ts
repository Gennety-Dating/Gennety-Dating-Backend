import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

vi.mock("./push.js", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(true),
}));

vi.mock("../utils/elo-calculator.js", () => ({
  applyEmergencyCancellationPeerBoost: vi.fn().mockResolvedValue(505),
}));

import { prisma } from "@gennety/db";
import { applyEmergencyCancellationPeerBoost } from "../utils/elo-calculator.js";
import { sendPushToUser } from "./push.js";
import {
  cancelInFlightMatchesForUser,
  IN_FLIGHT_MATCH_STATUSES,
} from "./cancel-in-flight-matches.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findMany: MockFn; updateMany: MockFn };
const mComp = applyEmergencyCancellationPeerBoost as unknown as MockFn;
const mPush = sendPushToUser as unknown as MockFn;

const LEAVING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PARTNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
  mMatch.updateMany.mockResolvedValue({ count: 1 });
});

describe("cancelInFlightMatchesForUser", () => {
  it("queries ALL four in-flight statuses (not just proposed/negotiating)", async () => {
    mMatch.findMany.mockResolvedValueOnce([]);
    await cancelInFlightMatchesForUser(LEAVING, null);

    const where = mMatch.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual([...IN_FLIGHT_MATCH_STATUSES]);
    expect(where.status.in).toContain("negotiating_venue");
    expect(where.status.in).toContain("scheduled");
    expect(where.OR).toEqual([{ userAId: LEAVING }, { userBId: LEAVING }]);
  });

  it("cancels a scheduled match, comps the partner, and DMs the telegram partner", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m1",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "ru", platform: "telegram" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    const result = await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: { in: [...IN_FLIGHT_MATCH_STATUSES] } },
      data: { status: "cancelled" },
    });
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body] = sendMessage.mock.calls[0];
    expect(chatId).toBe(200);
    expect(typeof body).toBe("string");
    expect(result).toEqual([
      {
        matchId: "m1",
        partnerUserId: PARTNER,
        partnerTelegramId: 200n,
        partnerLanguage: "ru",
        partnerPlatform: "telegram",
      },
    ]);
  });

  it("resolves the partner as userA when the leaving user is side B", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m2",
        userAId: PARTNER,
        userBId: LEAVING,
        userA: { telegramId: 300n, language: "en", platform: "telegram" },
        userB: { telegramId: 400n, language: "en", platform: "telegram" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    const result = await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage.mock.calls[0][0]).toBe(300);
    expect(result[0].partnerUserId).toBe(PARTNER);
  });

  it("pushes a neutral cancellation notice to a mobile-only partner", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m3",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: -7n, language: "en", platform: "mobile" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mPush).toHaveBeenCalledWith(PARTNER, {
      title: "Gennety",
      body: expect.any(String),
      data: { type: "match.cancelled", matchId: "m3" },
    });
  });

  it("with api=null, cancels + comps without sending any DM", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m4",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
    ]);

    const result = await cancelInFlightMatchesForUser(LEAVING, null);

    expect(mMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(result).toHaveLength(1);
  });

  it("continues to the next match when one status update throws", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "bad",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
      {
        id: "good",
        userAId: LEAVING,
        userBId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 300n, language: "en", platform: "telegram" },
      },
    ]);
    mMatch.updateMany
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce({ count: 1 });
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    const result = await cancelInFlightMatchesForUser(LEAVING, api);

    // The failed match is skipped; the good one still cancels + notifies.
    expect(result).toEqual([
      {
        matchId: "good",
        partnerUserId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        partnerTelegramId: 300n,
        partnerLanguage: "en",
        partnerPlatform: "telegram",
      },
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a concurrently resolved match or double-compensate", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "raced",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
    ]);
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await cancelInFlightMatchesForUser(LEAVING, null);

    expect(result).toEqual([]);
    expect(mComp).not.toHaveBeenCalled();
  });

  it("propagates DB cancellation failures in strict mode", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "bad",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
    ]);
    mMatch.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(
      cancelInFlightMatchesForUser(LEAVING, null, { strict: true }),
    ).rejects.toThrow("db down");
  });
});
