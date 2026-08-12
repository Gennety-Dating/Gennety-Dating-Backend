/**
 * Regression tests for the pre-date safety brief fanout.
 *
 * C-3 (original): a single Telegram send failure (e.g. F user blocked the bot,
 * or a mobile-only synthetic negative telegramId reached `Number(...)`)
 * aborted the for-loop before `safetyNoteSentAt` was stamped, so the next tick
 * re-fanned the same batch and survivors received duplicates.
 *
 * §5.4: the brief now goes out on each side's OWN rail. Two of the cases below
 * used to assert that a mobile woman is skipped — which was the defect, not
 * the rule, and they only passed because their fixtures carried no `platform`
 * at all. Reachability and gender are separate questions here, so both are
 * pinned separately.
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

vi.mock("./push.js", () => ({ sendPushToUser: vi.fn() }));

import { prisma } from "@gennety/db";
import { sendPushToUser } from "./push.js";
import { runPreDateSafetyTick, SAFETY_BRIEF_PUSH_TYPE } from "./pre-date-safety.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findMany: MockFn; update: MockFn; updateMany: MockFn };
const mPush = sendPushToUser as unknown as MockFn;

beforeEach(() => {
  vi.resetAllMocks();
  mMatch.updateMany.mockResolvedValue({ count: 1 });
  mPush.mockResolvedValue(true);
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
        userA: { id: "a", telegramId: 1n, platform: "telegram", gender: "female", language: "en" },
        userB: { id: "b", telegramId: 2n, platform: "telegram", gender: "female", language: "en" },
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

  it("stamps + skips when nobody on the match can be reached at all", async () => {
    // A legacy row with a synthetic negative id and no platform: no DM
    // possible, no push token rail claimed. Stamp anyway so we don't
    // re-evaluate this match every tick.
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-unreachable",
        venueName: "Cafe",
        userA: { id: "a", telegramId: -1n, platform: null, gender: "female", language: "en" },
        userB: { id: "b", telegramId: -2n, platform: null, gender: "female", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn() } as any;
    await runPreDateSafetyTick(api, new Date());

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mPush).not.toHaveBeenCalled();
    expect(mMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "match-unreachable", safetyNoteSentAt: null }),
        data: expect.objectContaining({ safetyNoteSentAt: expect.any(Date) }),
      }),
    );
  });
});

describe("runPreDateSafetyTick (§5.4 — each side on her own rail)", () => {
  it("pushes to a woman on the app, DMs a woman on Telegram, tells the man nothing", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-mobile-f",
        venueName: "Park",
        userA: { id: "she", telegramId: -7n, platform: "mobile", gender: "female", language: "en" },
        userB: { id: "he", telegramId: 999n, platform: "telegram", gender: "male", language: "en" },
      },
      {
        id: "match-telegram-f",
        venueName: "Cafe",
        userA: { id: "her", telegramId: 555n, platform: "telegram", gender: "female", language: "en" },
        userB: { id: "him", telegramId: 777n, platform: "telegram", gender: "male", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    await runPreDateSafetyTick(api, new Date());

    // The man is on neither rail: gender selects the recipient, and it is not
    // him on either match.
    expect(mPush).toHaveBeenCalledTimes(1);
    expect(mPush.mock.calls[0][0]).toBe("she");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(555);
  });

  // The rail that did not exist: a woman who signed in through Telegram carries
  // a REAL positive id on an account the bot cannot message (§1.1), so an
  // id-based filter reported success and delivered nothing.
  it("uses platform, not the id's sign, to pick the rail", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-tglogin",
        venueName: "Park",
        userA: {
          id: "she",
          telegramId: 424242n, // real id, app-only account
          platform: "mobile",
          gender: "female",
          language: "en",
        },
        userB: { id: "he", telegramId: 999n, platform: "telegram", gender: "male", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    await runPreDateSafetyTick(api, new Date());

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mPush).toHaveBeenCalledTimes(1);
  });

  it("carries both rails for a woman who is on Telegram AND the app", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-both",
        venueName: "Park",
        userA: { id: "she", telegramId: 12n, platform: "both", gender: "female", language: "en" },
        userB: { id: "he", telegramId: 999n, platform: "telegram", gender: "male", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    await runPreDateSafetyTick(api, new Date());

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(mPush).toHaveBeenCalledTimes(1);
  });

  // The type is what earns the notification its Focus privilege
  // (`TIME_SENSITIVE_PUSH_TYPES`), so it is part of the contract, not a label.
  it("sends the type the client and the interruption-level policy both key off", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-type",
        venueName: "Park",
        userA: { id: "she", telegramId: -7n, platform: "mobile", gender: "female", language: "en" },
        userB: { id: "he", telegramId: 999n, platform: "telegram", gender: "male", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    await runPreDateSafetyTick(api, new Date());

    expect(SAFETY_BRIEF_PUSH_TYPE).toBe("safety.brief");
    expect(mPush.mock.calls[0][1]).toMatchObject({
      data: { type: "safety.brief", matchId: "match-type" },
    });
  });

  // A push that throws must not abort the batch before the DM leg runs — the
  // same property the C-3 fix gave the Telegram side.
  it("survives a push failure without losing the DM or the stamp", async () => {
    mPush.mockRejectedValueOnce(new Error("apns down"));
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "match-pushfail",
        venueName: "Park",
        userA: { id: "she", telegramId: 12n, platform: "both", gender: "female", language: "en" },
        userB: { id: "he", telegramId: 999n, platform: "telegram", gender: "male", language: "en" },
      },
    ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await runPreDateSafetyTick(api, new Date());

    expect(result.sent).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
});
