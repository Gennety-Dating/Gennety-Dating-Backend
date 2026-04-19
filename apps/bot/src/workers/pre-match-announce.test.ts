import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../config.js", () => ({
  env: { OPENAI_API_KEY: "test-key" },
}));

import { prisma } from "@gennety/db";
import { preMatchAnnounceTick, getAnnounceFallback } from "./pre-match-announce.js";

const DAY_TIME  = new Date("2024-06-15T11:00:00Z");
const QUIET_TIME = new Date("2024-06-15T02:00:00Z");

function createMockApi() {
  return { sendMessage: vi.fn().mockResolvedValue({}) } as any;
}

function openaiOk(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

describe("preMatchAnnounceTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("returns 0 during quiet hours without DB query", async () => {
    const api = createMockApi();
    const result = await preMatchAnnounceTick(api, { now: QUIET_TIME });

    expect(result).toEqual({ announced: 0 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("returns 0 when no active users found", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const api = createMockApi();
    const result = await preMatchAnnounceTick(api, { now: DAY_TIME });

    expect(result).toEqual({ announced: 0 });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("sends announce to eligible active users", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { telegramId: BigInt(1), language: "en", firstName: "Alice", lastPreMatchAnnounceAt: null },
      { telegramId: BigInt(2), language: "ru", firstName: "Иван",  lastPreMatchAnnounceAt: null },
    ]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Get ready — your match drops tomorrow!"));
    const api = createMockApi();

    const result = await preMatchAnnounceTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.announced).toBe(2);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
  });

  it("stamps lastPreMatchAnnounceAt after sending", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { telegramId: BigInt(1), language: "en", firstName: "Alice", lastPreMatchAnnounceAt: null },
    ]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Tomorrow!"));
    const api = createMockApi();

    await preMatchAnnounceTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { telegramId: BigInt(1) },
      data: { lastPreMatchAnnounceAt: DAY_TIME },
    });
  });

  it("uses cooldown filter to prevent double-sending within 6 days", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const api = createMockApi();
    await preMatchAnnounceTick(api, { now: DAY_TIME });

    const call = (prisma.user.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe("active");
    // Must have OR condition for null or old announce time
    expect(call.where.OR).toBeDefined();
    expect(call.where.OR).toHaveLength(2);
  });

  it("uses fallback when OpenAI fails", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { telegramId: BigInt(1), language: "en", firstName: "Alice", lastPreMatchAnnounceAt: null },
    ]);

    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const api = createMockApi();

    const result = await preMatchAnnounceTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.announced).toBe(1);
    const sentText: string = api.sendMessage.mock.calls[0][1];
    expect(sentText).toContain("Alice");
  });

  it("handles blocked users gracefully", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { telegramId: BigInt(1), language: "en", firstName: "Alice", lastPreMatchAnnounceAt: null },
    ]);

    const mockFetch = vi.fn().mockResolvedValue(openaiOk("Tomorrow!"));
    const api = createMockApi();
    api.sendMessage.mockRejectedValue(new Error("Forbidden"));

    const result = await preMatchAnnounceTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(result.announced).toBe(0);
  });
});

describe("getAnnounceFallback", () => {
  it("includes name in English", () => {
    expect(getAnnounceFallback("Alice", "en")).toContain("Alice");
    expect(getAnnounceFallback("Alice", "en")).toContain("perfect match");
  });

  it("returns Russian version", () => {
    const msg = getAnnounceFallback("Иван", "ru");
    expect(msg).toContain("Иван");
    expect(msg).toContain("пару");
  });

  it("works with empty name", () => {
    const msg = getAnnounceFallback("", "en");
    expect(msg).toContain("Hey");
  });
});
