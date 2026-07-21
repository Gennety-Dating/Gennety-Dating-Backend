import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: mockPrisma,
}));

import {
  clearStaleStatusPins,
  createStatusBanner,
  pinStatusBanner,
} from "./status-banner.js";

function makeApi() {
  return {
    unpinAllChatMessages: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 555 }),
    pinChatMessage: vi.fn().mockResolvedValue(true),
    unpinChatMessage: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  } as any;
}

describe("pinStatusBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears stale pinned banners before pinning a fresh one", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ statusMessageId: null });
    mockPrisma.user.update.mockResolvedValue({});
    const api = makeApi();

    await pinStatusBanner(api, 42n, "en", new Date("2026-06-03T09:00:00Z"));

    // The old pins are cleared first, then the new banner is sent + pinned.
    expect(api.unpinAllChatMessages).toHaveBeenCalledWith(42);
    expect(api.unpinAllChatMessages).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![1]).toContain("✦ GENNETY DROP");
    expect(api.sendMessage.mock.calls[0]![2].reply_markup.inline_keyboard[0][0]).toEqual(
      expect.objectContaining({ callback_data: "menu:open", style: "primary" }),
    );
    expect(api.pinChatMessage).toHaveBeenCalledWith(42, 555, {
      disable_notification: true,
    });
    expect(api.unpinAllChatMessages.mock.invocationCallOrder[0]).toBeLessThan(
      api.sendMessage.mock.invocationCallOrder[0],
    );
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { telegramId: 42n },
      data: { statusMessageId: 555 },
    });
  });

  it("does not touch the chat when a banner is already tracked", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ statusMessageId: 100 });
    const api = makeApi();

    await pinStatusBanner(api, 42n, "en");

    expect(api.unpinAllChatMessages).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.pinChatMessage).not.toHaveBeenCalled();
  });

  it("still pins when clearing old pins fails", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ statusMessageId: null });
    mockPrisma.user.update.mockResolvedValue({});
    const api = makeApi();
    api.unpinAllChatMessages.mockRejectedValue(new Error("no rights"));

    await pinStatusBanner(api, 42n, "en");

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.pinChatMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("skips mobile-only synthetic (negative-id) users", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ statusMessageId: null });
    const api = makeApi();

    await pinStatusBanner(api, -7n, "en");

    expect(api.unpinAllChatMessages).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("compensates the Telegram message when DB persistence fails", async () => {
    mockPrisma.user.update.mockRejectedValue(new Error("db unavailable"));
    const api = makeApi();

    const result = await createStatusBanner(api, 42n, "en", {
      now: new Date("2026-06-03T09:00:00Z"),
    });

    expect(result).toMatchObject({ kind: "failed", failure: "transient" });
    expect(api.unpinChatMessage).toHaveBeenCalledWith(42, 555);
    expect(api.deleteMessage).toHaveBeenCalledWith(42, 555);
  });

  it("serializes concurrent creation so only one banner is sent", async () => {
    let pointer: number | null = null;
    mockPrisma.user.findUnique.mockImplementation(async () => ({
      statusMessageId: pointer,
    }));
    mockPrisma.user.update.mockImplementation(async () => {
      pointer = 555;
      return {};
    });
    const api = makeApi();

    const results = await Promise.all([
      createStatusBanner(api, 42n, "en"),
      createStatusBanner(api, 42n, "en"),
    ]);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "already_tracked",
      "created",
    ]);
  });

  it("clears an orphaned pin before a recreated account starts onboarding", async () => {
    const api = makeApi();

    await clearStaleStatusPins(api, 42n);

    expect(api.unpinAllChatMessages).toHaveBeenCalledWith(42);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
