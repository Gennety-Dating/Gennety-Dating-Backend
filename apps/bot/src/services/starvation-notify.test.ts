import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@gennety/db";
import { notifyStarved } from "./starvation-notify.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFindMany = (prisma.user as unknown as { findMany: MockFn }).findMany;

function makeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("notifyStarved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zeros on empty input without hitting the DB", async () => {
    const api = makeApi();
    const result = await notifyStarved(api as any, [], 0);
    expect(result.notified).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mUserFindMany).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("sends the localised ping to each Telegram user", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
      { id: "u2", telegramId: 222n, language: "ru" },
      { id: "u3", telegramId: 333n, language: "uk" },
    ]);
    const api = makeApi();

    const result = await notifyStarved(api as any, ["u1", "u2", "u3"], 0);

    expect(result.notified).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(api.sendMessage).toHaveBeenCalledTimes(3);

    const [, enBody] = api.sendMessage.mock.calls[0]!;
    const [, ruBody] = api.sendMessage.mock.calls[1]!;
    const [, ukBody] = api.sendMessage.mock.calls[2]!;

    expect(enBody).toContain("10/10");
    expect(ruBody).toContain("10/10");
    expect(ukBody).toContain("10/10");
    // Each locale differs
    expect(new Set([enBody, ruBody, ukBody]).size).toBe(3);
  });

  it("defaults to English when the user has no language set", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: null },
    ]);
    const api = makeApi();

    await notifyStarved(api as any, ["u1"], 0);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/algorithm didn't find/i);
  });

  it("skips mobile-only accounts with a synthetic negative telegramId", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "tg", telegramId: 555n, language: "en" },
      { id: "mobile", telegramId: -42n, language: "en" },
    ]);
    const api = makeApi();

    const result = await notifyStarved(api as any, ["tg", "mobile"], 0);

    expect(result.notified).toBe(1);
    expect(result.skipped).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(555);
  });

  it("continues on send failure and reports the error", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
      { id: "u2", telegramId: 222n, language: "en" },
      { id: "u3", telegramId: 333n, language: "en" },
    ]);
    const api = makeApi();
    api.sendMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Telegram 403: blocked"))
      .mockResolvedValueOnce(undefined);

    const result = await notifyStarved(api as any, ["u1", "u2", "u3"], 0);

    expect(result.notified).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.userId).toBe("u2");
    expect(result.errors[0]!.error).toContain("403");
  });
});
