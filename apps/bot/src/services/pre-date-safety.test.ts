/**
 * Regression tests for the pre-date safety brief fanout (C-3).
 *
 * Pre-fix, a single Telegram send failure (e.g. F user blocked the bot, or a
 * mobile-only synthetic negative telegramId reached `Number(...)`) aborted
 * the for-loop before `safetyNoteSentAt` was stamped, so the next tick
 * re-fanned the same batch and survivors received duplicates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from "@gennety/db";
import { runPreDateSafetyTick } from "./pre-date-safety.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findMany: MockFn; update: MockFn; updateMany: MockFn };

beforeEach(() => {
  vi.resetAllMocks();
  mMatch.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("runPreDateSafetyTick (C-3 fanout fix)", () => {
  it("stamps safetyNoteSentAt even when a recipient send fails", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-fail",
        venueName: "Coffee House",
        userA: { telegramId: 1n, gender: "female", language: "en" },
        userB: { telegramId: 2n, gender: "female", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("403 Forbidden: bot was blocked"))
        .mockResolvedValue(undefined),
    } as any;

    const result = await runPreDateSafetyTick(api, new Date());

    expect(result.sent).toBe(1);
    // CRITICAL: idempotency marker stamped despite one failed leg
    expect(mMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "match-fail", safetyNoteSentAt: null }),
        data: expect.objectContaining({ safetyNoteSentAt: expect.any(Date) }),
      }),
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("skips mobile-only female users (telegramId <= 0n)", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-mobile",
        venueName: "Park",
        userA: { telegramId: -7n, gender: "female", language: "en" }, // mobile-only
        userB: { telegramId: 999n, gender: "female", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    await runPreDateSafetyTick(api, new Date());

    // Only the telegram-resident user is messaged
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect((api.sendMessage as any).mock.calls[0][0]).toBe(999);
  });

  it("stamps + skips when no telegram recipients remain", async () => {
    // Both users mobile-only — no DM possible. Stamp anyway so we don't
    // re-evaluate this match every tick.
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-allmobile",
        venueName: "Cafe",
        userA: { telegramId: -1n, gender: "female", language: "en" },
        userB: { telegramId: -2n, gender: "female", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn() } as any;
    await runPreDateSafetyTick(api, new Date());

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "match-allmobile", safetyNoteSentAt: null }),
        data: expect.objectContaining({ safetyNoteSentAt: expect.any(Date) }),
      }),
    );
  });
});
