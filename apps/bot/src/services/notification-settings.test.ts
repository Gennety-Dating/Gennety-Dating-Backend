import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("./profiler.js", () => ({
  setProfilerEnabled: vi.fn().mockResolvedValue({ releasedMessageId: 9 }),
}));

import { prisma } from "@gennety/db";
import { setProfilerEnabled } from "./profiler.js";
import {
  applyNotificationSettings,
  getNotificationSettings,
  parseNotificationSettingsPatch,
} from "./notification-settings.js";

type MockFn = ReturnType<typeof vi.fn>;
const mFind = (prisma.user as unknown as { findUnique: MockFn }).findUnique;
const mUserUpdate = (prisma.user as unknown as { update: MockFn }).update;
const NOW = new Date("2026-11-26T08:00:00Z");

beforeEach(() => vi.clearAllMocks());

describe("parseNotificationSettingsPatch", () => {
  it("accepts a boolean switch", () => {
    expect(parseNotificationSettingsPatch({ profilerQuestions: false })).toEqual({ patch: { profilerQuestions: false } });
    expect(parseNotificationSettingsPatch({ onlyMyDates: true, profilerQuestions: true })).toEqual({
      patch: { onlyMyDates: true, profilerQuestions: true },
    });
  });
  it.each([
    [null, "Body must be an object"],
    [[], "Body must be an object"],
    [{}, "Nothing to update"],
    [{ profilerQuestions: "no" }, "profilerQuestions must be a boolean"],
    [{ profilerPausedUntil: null }, "Unknown field: profilerPausedUntil"],
  ])("refuses %j", (body, error) => {
    expect(parseNotificationSettingsPatch(body)).toEqual({ error });
  });
});

describe("getNotificationSettings", () => {
  it("is on for a person who never touched it", async () => {
    mFind.mockResolvedValue({ notifyOnlyDates: false, profile: { profilerOptedOutAt: null, profilerPausedUntil: null } });
    expect(await getNotificationSettings("u1", NOW)).toEqual({ profilerQuestions: true, profilerPausedUntil: null, onlyMyDates: false });
  });
  it("reports the switch and a pause still running, never an old one", async () => {
    const until = new Date(NOW.getTime() + 86_400_000);
    mFind.mockResolvedValueOnce({ notifyOnlyDates: true, profile: { profilerOptedOutAt: NOW, profilerPausedUntil: until } });
    expect(await getNotificationSettings("u1", NOW)).toMatchObject({
      profilerQuestions: false,
      profilerPausedUntil: until.toISOString(),
      onlyMyDates: true,
    });
    mFind.mockResolvedValueOnce({ notifyOnlyDates: false, profile: { profilerOptedOutAt: null, profilerPausedUntil: new Date(NOW.getTime() - 1) } });
    expect((await getNotificationSettings("u1", NOW)).profilerPausedUntil).toBeNull();
  });
});

describe("applyNotificationSettings", () => {
  it("routes the Profiler switch through setProfilerEnabled", async () => {
    const res = await applyNotificationSettings("u1", { profilerQuestions: false }, NOW);
    expect(setProfilerEnabled).toHaveBeenCalledWith("u1", false, NOW);
    expect(res.releasedMessageId).toBe(9);
  });
});

describe("applyNotificationSettings — only my dates (phase 4 item 6)", () => {
  it("writes User.notifyOnlyDates and leaves the Profiler alone", async () => {
    await applyNotificationSettings("u1", { onlyMyDates: true }, NOW);
    expect(mUserUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { notifyOnlyDates: true } });
    expect(setProfilerEnabled).not.toHaveBeenCalled();
  });
});
