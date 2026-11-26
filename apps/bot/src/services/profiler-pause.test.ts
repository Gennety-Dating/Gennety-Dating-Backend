import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    profile: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    },
    profilerAnswer: { upsert: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(null) },
    match: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { prisma } from "@gennety/db";
import { PROFILER_IGNORED_PAUSE_MS } from "@gennety/shared";
import {
  expireStalledProfilerQuestion,
  ignoredStreakPatch,
  recordProfilerStop,
  setProfilerEnabled,
  upsertProfilerAnswer,
  upsertProfilerSkip,
} from "./profiler.js";
import { profilerQuestionById } from "@gennety/shared";
import { isProfilerRefusal, isProfilerStopRequest } from "./profiler-intent.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUpdate = (prisma.profile as unknown as { update: MockFn }).update;
const mUpdateMany = (prisma.profile as unknown as { updateMany: MockFn }).updateMany;
const mFind = (prisma.profile as unknown as { findUnique: MockFn }).findUnique;
const mUserFind = (prisma.user as unknown as { findUnique: MockFn }).findUnique;

const NOW = new Date("2026-11-26T08:00:00Z");
const sendMessage = vi.fn().mockResolvedValue({});
const api = { sendMessage, editMessageReplyMarkup: vi.fn().mockResolvedValue({}), deleteMessage: vi.fn().mockResolvedValue(true) } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mUpdate.mockResolvedValue({});
  mUpdateMany.mockResolvedValue({ count: 1 });
});

describe("ignoredStreakPatch", () => {
  it("counts the first ignored batch without pausing", () => {
    expect(ignoredStreakPatch(0, NOW)).toEqual({ profilerIgnoredStreak: 1 });
  });
  it("pauses Telegram batches for 14 days at the second in a row and starts the count over", () => {
    const patch = ignoredStreakPatch(1, NOW);
    expect(patch.profilerIgnoredStreak).toBe(0);
    expect(patch.profilerPausedUntil?.getTime()).toBe(NOW.getTime() + PROFILER_IGNORED_PAUSE_MS);
    expect(PROFILER_IGNORED_PAUSE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe("expireStalledProfilerQuestion — ignored streak", () => {
  function stalled(streak: number, messageId: number | null) {
    mFind
      .mockResolvedValueOnce({
        profilerActiveQuestionId: "f_date_spots",
        profilerIgnoredStreak: streak,
        timeZone: "Europe/Kyiv",
        user: { telegramId: 123n },
      })
      // claimActiveQuestion reads the message id before nulling it
      .mockResolvedValueOnce({ profilerQuestionMessageId: messageId });
  }

  it("a stalled Telegram question adds one to the streak", async () => {
    stalled(0, 77);
    await expireStalledProfilerQuestion("u1", NOW, api);
    const data = mUpdate.mock.calls.at(-1)![0].data;
    expect(data.profilerIgnoredStreak).toBe(1);
    expect(data.profilerPausedUntil).toBeUndefined();
  });

  it("the second in a row pauses for 14 days", async () => {
    stalled(1, 77);
    await expireStalledProfilerQuestion("u1", NOW, api);
    const data = mUpdate.mock.calls.at(-1)![0].data;
    expect(data.profilerIgnoredStreak).toBe(0);
    expect(data.profilerPausedUntil).toEqual(new Date(NOW.getTime() + PROFILER_IGNORED_PAUSE_MS));
  });

  it("an app-opened question (no Telegram message) does not count", async () => {
    stalled(1, null);
    await expireStalledProfilerQuestion("u1", NOW, api);
    const data = mUpdate.mock.calls.at(-1)![0].data;
    expect(data).not.toHaveProperty("profilerIgnoredStreak");
    expect(data).not.toHaveProperty("profilerPausedUntil");
  });
});

describe("answers and skips reset the streak", () => {
  const question = profilerQuestionById("f_date_spots")!;
  it("an answer resets it, guarded so a clean row costs nothing", async () => {
    await upsertProfilerAnswer("u1", question, "кофе", NOW, "2026-W48");
    expect(mUpdateMany).toHaveBeenCalledWith({
      where: { userId: "u1", profilerIgnoredStreak: { gt: 0 } },
      data: { profilerIgnoredStreak: 0 },
    });
  });
  it("a skip resets it too — a skip is the person engaging", async () => {
    await upsertProfilerSkip("u1", question, "2026-W48");
    expect(mUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { profilerIgnoredStreak: 0 } }),
    );
  });
});

describe("setProfilerEnabled — the off switch", () => {
  it("off stamps the switch and releases a live question", async () => {
    mFind.mockResolvedValueOnce({
      timeZone: "Europe/Kyiv",
      profilerStartedAt: NOW,
      profilerNextAt: null,
      profilerOptedOutAt: null,
      profilerQuestionMessageId: 55,
    });
    const res = await setProfilerEnabled("u1", false, NOW);
    expect(res.releasedMessageId).toBe(55);
    const data = mUpdate.mock.calls[0]![0].data;
    expect(data.profilerOptedOutAt).toEqual(NOW);
    expect(data.profilerActiveQuestionId).toBeNull();
    expect(data.profilerBatchRemaining).toBe(0);
  });

  it("off again keeps the first stamp", async () => {
    const earlier = new Date("2026-11-01T00:00:00Z");
    mFind.mockResolvedValueOnce({
      timeZone: null, profilerStartedAt: NOW, profilerNextAt: null,
      profilerOptedOutAt: earlier, profilerQuestionMessageId: null,
    });
    await setProfilerEnabled("u1", false, NOW);
    expect(mUpdate.mock.calls[0]![0].data.profilerOptedOutAt).toEqual(earlier);
  });

  it("on clears the switch, the pause and the count, and re-arms an empty schedule", async () => {
    mFind.mockResolvedValueOnce({
      timeZone: "Europe/Kyiv", profilerStartedAt: NOW, profilerNextAt: null,
      profilerOptedOutAt: NOW, profilerQuestionMessageId: null,
    });
    await setProfilerEnabled("u1", true, NOW);
    const data = mUpdate.mock.calls[0]![0].data;
    expect(data.profilerOptedOutAt).toBeNull();
    expect(data.profilerPausedUntil).toBeNull();
    expect(data.profilerIgnoredStreak).toBe(0);
    expect(data.profilerNextAt).toBeInstanceOf(Date);
    expect(data.profilerNextAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("«не спрашивай больше»", () => {
  it("is a stop request, while a bare «не спрашивай» stays a one-off refusal", () => {
    expect(isProfilerStopRequest("Не спрашивай больше!")).toBe(true);
    expect(isProfilerStopRequest("хватит вопросов")).toBe(true);
    expect(isProfilerStopRequest("stop asking")).toBe(true);
    expect(isProfilerStopRequest("не питай більше")).toBe(true);
    expect(isProfilerStopRequest("не спрашивай")).toBe(false);
    expect(isProfilerRefusal("не спрашивай")).toBe(true);
    expect(isProfilerStopRequest("не спрашивай больше про кино, спроси про музыку")).toBe(false);
  });

  it("records a skip, switches the Profiler off and says how to turn it back on", async () => {
    // claimActiveQuestion → message id; setProfilerEnabled → profile
    mFind
      .mockResolvedValueOnce({ profilerQuestionMessageId: 77 })
      .mockResolvedValueOnce({
        timeZone: null, profilerStartedAt: NOW, profilerNextAt: NOW,
        profilerOptedOutAt: null, profilerQuestionMessageId: null,
      });
    mUserFind.mockResolvedValue({
      id: "u1", telegramId: 123n, gender: "female", language: "ru",
      profile: { timeZone: null, profilerBatchRemaining: 0, profilerActiveQuestionId: null, profilerQuestionMessageId: null },
      profilerAnswers: [],
    });
    const ok = await recordProfilerStop(api, "u1", "f_date_spots", { now: NOW });
    expect(ok).toBe(true);
    const offWrite = mUpdate.mock.calls.find((c) => c[0].data.profilerOptedOutAt)?.[0].data;
    expect(offWrite?.profilerOptedOutAt).toEqual(NOW);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Настройк"));
  });
});
