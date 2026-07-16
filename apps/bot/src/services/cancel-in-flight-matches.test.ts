import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../utils/elo-calculator.js", () => ({
  applyEmergencyCancellationPeerBoost: vi.fn().mockResolvedValue(505),
}));

import { prisma } from "@gennety/db";
import { applyEmergencyCancellationPeerBoost } from "../utils/elo-calculator.js";
import {
  cancelInFlightMatchesForUser,
  IN_FLIGHT_MATCH_STATUSES,
} from "./cancel-in-flight-matches.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findMany: MockFn; update: MockFn };
const mComp = applyEmergencyCancellationPeerBoost as unknown as MockFn;

const LEAVING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PARTNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
  mMatch.update.mockResolvedValue({});
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
        userA: { telegramId: 100n, language: "en" },
        userB: { telegramId: 200n, language: "ru" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    const result = await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { status: "cancelled" },
    });
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body] = sendMessage.mock.calls[0];
    expect(chatId).toBe(200);
    expect(typeof body).toBe("string");
    expect(result).toEqual([
      { matchId: "m1", partnerUserId: PARTNER, partnerTelegramId: 200n, partnerLanguage: "ru" },
    ]);
  });

  it("resolves the partner as userA when the leaving user is side B", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m2",
        userAId: PARTNER,
        userBId: LEAVING,
        userA: { telegramId: 300n, language: "en" },
        userB: { telegramId: 400n, language: "en" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    const result = await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage.mock.calls[0][0]).toBe(300);
    expect(result[0].partnerUserId).toBe(PARTNER);
  });

  it("skips the DM for a mobile-only partner (negative telegramId) but still cancels + comps", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m3",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en" },
        userB: { telegramId: -7n, language: "en" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mMatch.update).toHaveBeenCalledTimes(1);
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("with api=null, cancels + comps without sending any DM", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m4",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en" },
        userB: { telegramId: 200n, language: "en" },
      },
    ]);

    const result = await cancelInFlightMatchesForUser(LEAVING, null);

    expect(mMatch.update).toHaveBeenCalledTimes(1);
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(result).toHaveLength(1);
  });

  it("continues to the next match when one status update throws", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "bad",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en" },
        userB: { telegramId: 200n, language: "en" },
      },
      {
        id: "good",
        userAId: LEAVING,
        userBId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        userA: { telegramId: 100n, language: "en" },
        userB: { telegramId: 300n, language: "en" },
      },
    ]);
    mMatch.update
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce({});
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
      },
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
