import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    match: { findMany: vi.fn() },
  },
}));

vi.mock("@gennety/db", () => ({ prisma: mockPrisma }));

import { buildStatusBannerView } from "../services/status-banner.js";
import { statusTimerTick } from "./status-timer.js";

const NOW = new Date("2026-07-21T09:00:00.000Z");

function telegramError(code: number, description: string, retryAfter?: number): GrammyError {
  return new GrammyError(
    description,
    {
      ok: false,
      error_code: code,
      description,
      ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
    },
    "editMessageText",
    {},
  );
}

function active(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    telegramId: 42n,
    language: "ru",
    status: "active",
    statusMessageId: 100,
    ...overrides,
  };
}

function makeApi() {
  return {
    unpinAllChatMessages: vi.fn().mockResolvedValue(true),
    unpinChatMessage: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 555 }),
    pinChatMessage: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    getChat: vi.fn().mockResolvedValue({ pinned_message: { message_id: 100 } }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.user.update.mockResolvedValue({});
  mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.match.findMany.mockResolvedValue([]);
});

describe("statusTimerTick", () => {
  it("self-heals an active user with a null DB pointer", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active({ statusMessageId: null })]);
    const api = makeApi();

    const result = await statusTimerTick(api, { now: NOW });

    expect(result.created).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("✦ GENNETY DROP"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(api.pinChatMessage).toHaveBeenCalledWith(42, 555, {
      disable_notification: true,
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { telegramId: 42n },
      data: { statusMessageId: 555 },
    });
  });

  it("keeps the drop button primary and appends the scheduled date", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    mockPrisma.match.findMany.mockResolvedValue([
      {
        userAId: "u1",
        userBId: "u2",
        agreedTime: new Date("2026-07-21T18:00:00.000Z"),
        venueName: "Blur Cafe",
      },
    ]);
    const api = makeApi();

    const result = await statusTimerTick(api, {
      now: NOW,
      forcePinAudit: true,
      renderCache: new Map(),
    });

    expect(result.edited).toBe(1);
    const [, , text, options] = api.editMessageText.mock.calls[0]!;
    expect(text).toContain("Blur Cafe");
    expect(options.reply_markup.inline_keyboard[0][0]).toEqual(
      expect.objectContaining({
        callback_data: "menu:open",
        style: "primary",
      }),
    );
    expect(options.reply_markup.inline_keyboard[0][0].text).toContain("До дропа");
  });

  it("re-pins a tracked message during the hourly physical audit", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.getChat.mockResolvedValue({ pinned_message: { message_id: 999 } });
    const signature = buildStatusBannerView("ru", NOW).signature;

    const result = await statusTimerTick(api, {
      now: NOW,
      forcePinAudit: true,
      renderCache: new Map([["42", signature]]),
    });

    expect(result.repinned).toBe(1);
    expect(api.pinChatMessage).toHaveBeenCalledWith(42, 100, {
      disable_notification: true,
    });
  });

  it("replaces a deleted Telegram message in the same tick", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.editMessageText.mockRejectedValue(
      telegramError(400, "Bad Request: message to edit not found"),
    );

    const result = await statusTimerTick(api, { now: NOW, renderCache: new Map() });

    expect(result.created).toBe(1);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", statusMessageId: 100 },
      data: { statusMessageId: null },
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    "paused",
    "frozen",
    "suspended",
    "pending_investigation",
    "banned",
  ])("clears a tracked banner for a %s account", async (status) => {
    mockPrisma.user.findMany.mockResolvedValue([active({ status })]);
    const api = makeApi();

    const result = await statusTimerTick(api, { now: NOW });

    expect(result.removedInactive).toBe(1);
    expect(api.unpinChatMessage).toHaveBeenCalledWith(42, 100);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", statusMessageId: 100 },
      data: { statusMessageId: null },
    });
  });

  it("keeps an inactive pointer when unpinning fails transiently", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active({ status: "paused" })]);
    const api = makeApi();
    api.unpinChatMessage.mockRejectedValue(new Error("network reset"));
    const retryState = new Map();

    const result = await statusTimerTick(api, { now: NOW, retryState });

    expect(result.transientFailures).toBe(1);
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    expect(retryState.get("42").retryAt).toBeGreaterThan(NOW.getTime());

    api.unpinChatMessage.mockClear();
    await statusTimerTick(api, {
      now: new Date(NOW.getTime() + 30_000),
      retryState,
    });
    expect(api.unpinChatMessage).not.toHaveBeenCalled();
  });

  it("honours retry_after and does not retry every minute", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.editMessageText.mockRejectedValue(
      telegramError(429, "Too Many Requests", 120),
    );
    const retryState = new Map();

    const first = await statusTimerTick(api, {
      now: NOW,
      retryState,
      renderCache: new Map(),
    });
    expect(first.transientFailures).toBe(1);

    api.editMessageText.mockClear();
    const second = await statusTimerTick(api, {
      now: new Date(NOW.getTime() + 60_000),
      retryState,
      renderCache: new Map(),
    });
    expect(second.unchanged).toBe(1);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it.each([
    ["5xx", telegramError(503, "Service Unavailable")],
    ["network", new Error("network reset")],
  ])("backs off after a transient %s failure", async (_label, error) => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.editMessageText.mockRejectedValue(error);
    const retryState = new Map();

    const result = await statusTimerTick(api, {
      now: NOW,
      retryState,
      renderCache: new Map(),
    });

    expect(result.transientFailures).toBe(1);
    expect(retryState.get("42").retryAt).toBeGreaterThan(NOW.getTime());
  });

  it("clears an unreachable pointer and applies a long cooldown", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.editMessageText.mockRejectedValue(
      telegramError(403, "Forbidden: bot was blocked by the user"),
    );
    const retryState = new Map();

    const result = await statusTimerTick(api, {
      now: NOW,
      retryState,
      renderCache: new Map(),
    });

    expect(result.permanentFailures).toBe(1);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", statusMessageId: 100 },
      data: { statusMessageId: null },
    });
    expect(retryState.get("42").retryAt).toBeGreaterThan(
      NOW.getTime() + 5 * 60 * 60 * 1000,
    );
  });
});
