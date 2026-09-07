import { describe, it, expect, vi, beforeEach } from "vitest";

const updateMany = vi.hoisted(() => vi.fn());
vi.mock("@gennety/db", () => ({ prisma: { user: { updateMany } } }));

import { Api, GrammyError } from "grammy";
import type { ApiResponse } from "grammy/types";
import {
  isPermanentTelegramRefusal,
  markBotBlocked,
  clearBotBlocked,
  installBotBlockedObserver,
} from "./bot-blocked.js";

const TOKEN = "123456:AAHtesttoken";

function grammyError(errorCode: number, description: string): GrammyError {
  return new GrammyError(
    "Call failed",
    { ok: false, error_code: errorCode, description },
    "sendMessage",
    {},
  );
}

/** Stand in for the network as the innermost transformer. */
function stubTransport(response: ApiResponse<unknown>) {
  const transformer = vi.fn(async () => response as never);
  return transformer as unknown as Parameters<Api["config"]["use"]>[0];
}

beforeEach(() => {
  updateMany.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
});

describe("isPermanentTelegramRefusal", () => {
  it("is every 403, whatever Telegram calls it this year", () => {
    expect(isPermanentTelegramRefusal(grammyError(403, "Forbidden: bot was blocked by the user"))).toBe(true);
    expect(isPermanentTelegramRefusal(grammyError(403, "Forbidden: user is deactivated"))).toBe(true);
    // Matching on prose would mean missing the next phrasing in silence.
    expect(isPermanentTelegramRefusal(grammyError(403, "Forbidden: something new"))).toBe(true);
  });

  it("is nothing else", () => {
    // A rate answer is about this second; a 5xx is Telegram's own problem; a
    // missing message is about one message. None of them shut the chat.
    expect(isPermanentTelegramRefusal(grammyError(429, "Too Many Requests"))).toBe(false);
    expect(isPermanentTelegramRefusal(grammyError(500, "Internal Server Error"))).toBe(false);
    expect(isPermanentTelegramRefusal(grammyError(400, "message to edit not found"))).toBe(false);
    expect(isPermanentTelegramRefusal(new Error("network down"))).toBe(false);
  });
});

describe("the observer", () => {
  it("remembers a 403 without changing what the caller gets back", async () => {
    const api = new Api(TOKEN);
    api.config.use(
      stubTransport({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      }),
    );
    installBotBlockedObserver(api);

    await expect(api.sendMessage(4242, "hi")).rejects.toThrow(/blocked/);

    expect(updateMany).toHaveBeenCalledWith({
      where: { telegramId: 4242n, botBlockedAt: null },
      data: { botBlockedAt: expect.any(Date) },
    });
  });

  it("writes nothing on a send that worked", async () => {
    const api = new Api(TOKEN);
    api.config.use(
      stubTransport({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: 4242, type: "private" } },
      }),
    );
    installBotBlockedObserver(api);

    await api.sendMessage(4242, "hi");

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("writes nothing on a refusal that waiting can fix", async () => {
    const api = new Api(TOKEN);
    api.config.use(
      stubTransport({ ok: false, error_code: 429, description: "Too Many Requests" }),
    );
    installBotBlockedObserver(api);

    await expect(api.sendMessage(4242, "hi")).rejects.toThrow();

    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("marking and forgetting", () => {
  it("stamps only a chat that is not already marked", async () => {
    await markBotBlocked(4242n);
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      telegramId: 4242n,
      botBlockedAt: null,
    });
  });

  it("ignores a mobile-only synthetic id", async () => {
    // A negative id is not a Telegram chat, so it cannot be blocked by one.
    await markBotBlocked(-7n);
    await clearBotBlocked(-7n);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("never lets its own failure escape into a send path", async () => {
    updateMany.mockRejectedValue(new Error("db down"));
    await expect(markBotBlocked(4242n)).resolves.toBeUndefined();
  });

  it("clears the mark, because an update from the chat is the unblock", async () => {
    await clearBotBlocked(4242n);
    expect(updateMany).toHaveBeenCalledWith({
      where: { telegramId: 4242n, botBlockedAt: { not: null } },
      data: { botBlockedAt: null },
    });
  });
});
