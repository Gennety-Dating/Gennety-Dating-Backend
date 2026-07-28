import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    chatEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
  Prisma: { DbNull: Symbol("DbNull") },
}));

import { prisma } from "@gennety/db";
import {
  MAX_SUMMARY_LENGTH,
  clearChatTargetCache,
  forgetChatEventForMessage,
  getRecentChatEvents,
  invalidateChatTarget,
  recordChatEvent,
  recordChatEventForChat,
  resolveChatTarget,
  truncateSummary,
} from "./chat-events.js";

const create = prisma.chatEvent.create as ReturnType<typeof vi.fn>;
const findMany = prisma.chatEvent.findMany as ReturnType<typeof vi.fn>;
const deleteMany = prisma.chatEvent.deleteMany as ReturnType<typeof vi.fn>;
const findUser = prisma.user.findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearChatTargetCache();
  create.mockResolvedValue({});
  findMany.mockResolvedValue([]);
  deleteMany.mockResolvedValue({ count: 0 });
});

describe("truncateSummary", () => {
  it("collapses whitespace", () => {
    expect(truncateSummary("  a\n\n  b \t c ")).toBe("a b c");
  });

  it("clips long text to the cap", () => {
    const result = truncateSummary("x".repeat(MAX_SUMMARY_LENGTH + 50));
    expect(result).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("recordChatEvent", () => {
  it("writes a truncated row", async () => {
    await recordChatEvent({
      userId: "u1",
      direction: "out",
      kind: "text",
      summary: `  ${"y".repeat(MAX_SUMMARY_LENGTH + 10)}  `,
    });
    const data = create.mock.calls[0]![0].data;
    expect(data.userId).toBe("u1");
    expect(data.summary).toHaveLength(MAX_SUMMARY_LENGTH);
  });

  it("skips an empty summary", async () => {
    await recordChatEvent({ userId: "u1", direction: "out", kind: "text", summary: "   " });
    expect(create).not.toHaveBeenCalled();
  });

  it("never throws when the write fails", async () => {
    create.mockRejectedValue(new Error("db down"));
    await expect(
      recordChatEvent({ userId: "u1", direction: "out", kind: "text", summary: "hi" }),
    ).resolves.toBeUndefined();
  });
});

describe("getRecentChatEvents", () => {
  it("returns newest-last so the agent reads it in order", async () => {
    findMany.mockResolvedValue([
      { id: "2", summary: "newer", actions: null, createdAt: new Date(2) },
      { id: "1", summary: "older", actions: null, createdAt: new Date(1) },
    ]);
    const events = await getRecentChatEvents("u1");
    expect(events.map((e) => e.summary)).toEqual(["older", "newer"]);
  });

  it("degrades to an empty timeline rather than throwing", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    await expect(getRecentChatEvents("u1")).resolves.toEqual([]);
  });
});

describe("resolveChatTarget", () => {
  it("marks a post-onboarding user recordable", async () => {
    findUser.mockResolvedValue({ id: "u1", onboardingStep: "completed" });
    await expect(resolveChatTarget(555n)).resolves.toEqual({
      userId: "u1",
      recordable: true,
    });
  });

  it("refuses to record a user still in onboarding", async () => {
    findUser.mockResolvedValue({ id: "u1", onboardingStep: "conversational" });
    const target = await resolveChatTarget(555n);
    expect(target.recordable).toBe(false);
  });

  it("never records a mobile-only synthetic (negative) id", async () => {
    await expect(resolveChatTarget(-42n)).resolves.toEqual({
      userId: null,
      recordable: false,
    });
    expect(findUser).not.toHaveBeenCalled();
  });

  it("caches the lookup", async () => {
    findUser.mockResolvedValue({ id: "u1", onboardingStep: "completed" });
    await resolveChatTarget(555n);
    await resolveChatTarget(555n);
    expect(findUser).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the chat is invalidated (user just finished onboarding)", async () => {
    findUser.mockResolvedValue({ id: "u1", onboardingStep: "conversational" });
    await resolveChatTarget(555n);
    invalidateChatTarget(555n);
    findUser.mockResolvedValue({ id: "u1", onboardingStep: "completed" });
    await expect(resolveChatTarget(555n)).resolves.toEqual({
      userId: "u1",
      recordable: true,
    });
  });

  it("does not cache a failed lookup", async () => {
    findUser.mockRejectedValue(new Error("db down"));
    await resolveChatTarget(555n);
    findUser.mockResolvedValue({ id: "u1", onboardingStep: "completed" });
    await expect(resolveChatTarget(555n)).resolves.toEqual({
      userId: "u1",
      recordable: true,
    });
  });
});

describe("recordChatEventForChat", () => {
  it("writes for a completed user", async () => {
    findUser.mockResolvedValue({ id: "u1", onboardingStep: "completed" });
    await recordChatEventForChat(555, { direction: "in", kind: "user_text", summary: "why?" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].data.userId).toBe("u1");
  });

  it("stays silent for a user still onboarding", async () => {
    findUser.mockResolvedValue({ id: "u1", onboardingStep: "conversational" });
    await recordChatEventForChat(555, { direction: "in", kind: "user_text", summary: "hi" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("forgetChatEventForMessage", () => {
  it("deletes only that user's outbound row", async () => {
    await forgetChatEventForMessage("u1", 77);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", telegramMessageId: 77, direction: "out" },
    });
  });
});
