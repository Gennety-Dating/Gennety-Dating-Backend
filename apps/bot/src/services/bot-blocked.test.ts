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
  withBotReachabilityChange,
  __resetBotReachableForTests,
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
  __resetBotReachableForTests();
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
      where: { telegramId: 4242n, botBlockedAt: null, platform: { in: ["telegram", "both"] } },
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
      platform: { in: ["telegram", "both"] },
    });
  });

  it("never stamps an app-only account, even one carrying a real Telegram id (A13-H3)", async () => {
    // Telegram Login stores a REAL positive id on a `mobile` account that never
    // pressed Start. A send to it is refused with a 403 about a chat that never
    // existed; stamping it removed the person from every drop, and only an
    // incoming bot update — which an app-only user never sends — cleared it.
    await markBotBlocked(4242n);
    const where = updateMany.mock.calls[0]![0].where as { platform: { in: string[] } };
    expect(where.platform.in).not.toContain("mobile");
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

describe("the clearing UPDATE on every inbound update", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("runs once per id, then not again while nothing stamped it", async () => {
    await clearBotBlocked(4242n);
    await clearBotBlocked(4242n);
    await clearBotBlocked(4242n);

    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("runs for every id on its own, and again after a restart", async () => {
    await clearBotBlocked(4242n);
    await clearBotBlocked(5353n);
    __resetBotReachableForTests();
    await clearBotBlocked(4242n);

    expect(updateMany.mock.calls.map((c) => c[0].where.telegramId)).toEqual([4242n, 5353n, 4242n]);
  });

  it("runs again after the chat was stamped blocked", async () => {
    await clearBotBlocked(4242n);
    await markBotBlocked(4242n);
    await clearBotBlocked(4242n);

    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(updateMany.mock.calls[2]![0]).toEqual({
      where: { telegramId: 4242n, botBlockedAt: { not: null } },
      data: { botBlockedAt: null },
    });
  });

  it("does not remember a clear that a stamp overtook", async () => {
    // The stamp may commit after the clear, so the row can be stamped although
    // the clear succeeded — the next update has to clear again.
    const slowClear = deferred<{ count: number }>();
    updateMany.mockReturnValueOnce(slowClear.promise);
    const clearing = clearBotBlocked(4242n);
    await markBotBlocked(4242n);
    slowClear.resolve({ count: 0 });
    await clearing;

    await clearBotBlocked(4242n);

    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  it("does not remember a clear that started while a change was still in flight", async () => {
    const adoption = deferred<string>();
    const adopting = withBotReachabilityChange(4242n, () => adoption.promise);
    await clearBotBlocked(4242n);
    adoption.resolve("adopted");
    await expect(adopting).resolves.toBe("adopted");

    await clearBotBlocked(4242n);
    await clearBotBlocked(4242n);

    // Both clears after the change ran; only the last of them was skipped.
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("forgets an id that a change touches, even one already remembered", async () => {
    await clearBotBlocked(4242n);
    await withBotReachabilityChange(4242n, async () => undefined);
    await clearBotBlocked(4242n);

    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("does not remember a clear that failed", async () => {
    updateMany.mockRejectedValueOnce(new Error("pool timeout"));
    await clearBotBlocked(4242n);
    await clearBotBlocked(4242n);

    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});
