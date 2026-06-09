import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
    },
    match: {
      findFirst: vi.fn(),
    },
    noMatchNotice: {
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { prisma } from "@gennety/db";
import { sendNoMatchNotices, getDropDate } from "./no-match-notifier.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFindMany = (prisma.user as unknown as { findMany: MockFn }).findMany;
const mMatchFindFirst = (prisma.match as unknown as { findFirst: MockFn }).findFirst;
const mNoticeCount = (prisma.noMatchNotice as unknown as { count: MockFn }).count;
const mNoticeCreate = (prisma.noMatchNotice as unknown as { create: MockFn }).create;

function makeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

const NOW = new Date("2026-05-07T15:15:00Z"); // Thursday 18:15 Kyiv (UTC+3 summer)

describe("getDropDate", () => {
  it("floors to UTC midnight of the same day", () => {
    expect(getDropDate(NOW).toISOString()).toBe("2026-05-07T00:00:00.000Z");
  });
});

describe("sendNoMatchNotices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mNoticeCreate.mockResolvedValue({});
  });

  it("returns zero counts when no candidates are eligible", async () => {
    mUserFindMany.mockResolvedValueOnce([]);
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0);

    expect(result.notified).toBe(0);
    expect(result.tier1).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mNoticeCreate).not.toHaveBeenCalled();
  });

  it("sends tier-1 message for users with no prior notices and no past matches", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeCount.mockResolvedValueOnce(0);
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0);

    expect(result.notified).toBe(1);
    expect(result.tier1).toBe(1);
    expect(result.tier2).toBe(0);
    expect(result.tier3plus).toBe(0);

    const [chatId, body, opts] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(body).toMatch(/quality bar/);
    expect(opts.parse_mode).toBe("Markdown");

    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 1, dropDate: getDropDate(NOW) },
    });
  });

  it("escalates to tier 2 after one prior notice since the last match", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "ru" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: new Date("2026-04-15T15:00:00Z") });
    mNoticeCount.mockResolvedValueOnce(1);
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0);

    expect(result.tier2).toBe(1);
    expect(result.tier1).toBe(0);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/вторая неделя/i);

    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 2, dropDate: getDropDate(NOW) },
    });
  });

  it("buckets tier 3+ for any consecutive famine streak >= 3 weeks", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "uk" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeCount.mockResolvedValueOnce(2).mockResolvedValueOnce(7);
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0);

    expect(result.tier3plus).toBe(2);
    expect(result.tier1).toBe(0);
    expect(result.tier2).toBe(0);

    const [, body1] = api.sendMessage.mock.calls[0]!;
    const [, body2] = api.sendMessage.mock.calls[1]!;
    expect(body1).toMatch(/чесними/);
    expect(body2).toMatch(/honest update/);
  });

  it("skips mobile-only accounts (negative telegramId) without DB writes", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "tg", telegramId: 555n, language: "en" },
      { id: "mobile", telegramId: -42n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeCount.mockResolvedValue(0);
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0);

    expect(result.notified).toBe(1);
    expect(result.skipped).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    expect(mNoticeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "tg" }) }),
    );
  });

  it("continues on send failure and reports the error", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeCount.mockResolvedValue(0);
    const api = makeApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("Telegram 403: blocked"))
      .mockResolvedValueOnce(undefined);

    const result = await sendNoMatchNotices(api as never, NOW, 0);

    expect(result.notified).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.userId).toBe("u1");
    expect(result.errors[0]!.error).toMatch(/403/);
    // Claims are persisted before the side effect so overlapping workers
    // cannot both send the same weekly notice.
    expect(mNoticeCreate).toHaveBeenCalledTimes(2);
    expect(mNoticeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "u2" }) }),
    );
  });

  it("defaults to English when the user has no language set", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: null },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeCount.mockResolvedValueOnce(0);
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/quality bar/);
  });
});
