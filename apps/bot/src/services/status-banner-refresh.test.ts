import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findMany: vi.fn() },
    match: { findMany: vi.fn() },
  },
}));

vi.mock("@gennety/db", () => ({ prisma: mockPrisma }));

import { statusBannerRenderCache } from "./status-banner.js";
import { refreshStatusBanners } from "./status-banner-refresh.js";
import { statusTimerTick } from "../workers/status-timer.js";

const NOW = new Date("2026-07-21T09:00:00.000Z");
const DATE_AT = new Date("2026-07-23T16:00:00.000Z");

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    telegramId: 42n,
    language: "ru",
    status: "active",
    statusMessageId: 100,
    profile: { homeCityKey: "ua:kyiv", homeCity: "Київ" },
    ...overrides,
  };
}

/** A `scheduled` row shaped like `loadBannerStages`' own select. `u1` is side A. */
function scheduledAt(venueName: string | null) {
  return {
    status: "scheduled",
    userAId: "u1",
    userBId: "u2",
    agreedTime: DATE_AT,
    venueName,
    dispatchedAt: null,
    acceptedByA: true,
    acceptedByB: true,
    pitchMessageIdA: 1,
    pitchMessageIdB: 2,
  };
}

function api() {
  return {
    editMessageText: vi.fn().mockResolvedValue({}),
  } as unknown as Parameters<typeof refreshStatusBanners>[0] & {
    editMessageText: ReturnType<typeof vi.fn>;
  };
}

function telegramError(code: number, description: string): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code: code, description },
    "editMessageText",
    {},
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  statusBannerRenderCache.clear();
});

describe("refreshStatusBanners", () => {
  it("edits the pinned banner with the new venue immediately", async () => {
    mockPrisma.user.findMany.mockResolvedValue([participant()]);
    mockPrisma.match.findMany.mockResolvedValue([scheduledAt("Aroma Kava")]);
    const bot = api();

    await refreshStatusBanners(bot, ["u1", "u2"], NOW);

    expect(bot.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text] = bot.editMessageText.mock.calls[0]!;
    expect(chatId).toBe(42);
    expect(messageId).toBe(100);
    expect(text).toContain("Aroma Kava");
  });

  it("satisfies the next tick, so the venue is not re-sent a minute later", async () => {
    mockPrisma.user.findMany.mockResolvedValue([participant()]);
    mockPrisma.match.findMany.mockResolvedValue([scheduledAt("Aroma Kava")]);
    const bot = api();
    await refreshStatusBanners(bot, ["u1"], NOW);

    // The tick reads the same row a moment later, through the shared cache.
    const tickApi = {
      editMessageText: vi.fn().mockResolvedValue({}),
      getChat: vi.fn().mockResolvedValue({ pinned_message: { message_id: 100 } }),
      pinChatMessage: vi.fn(),
    } as never;
    mockPrisma.user.findMany.mockResolvedValue([participant()]);
    mockPrisma.match.findMany.mockResolvedValue([scheduledAt("Aroma Kava")]);

    const result = await statusTimerTick(tickApi, { now: NOW });

    expect(result.edited).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it("does nothing when the render is already current", async () => {
    mockPrisma.user.findMany.mockResolvedValue([participant()]);
    mockPrisma.match.findMany.mockResolvedValue([scheduledAt("Aroma Kava")]);
    const bot = api();

    await refreshStatusBanners(bot, ["u1"], NOW);
    await refreshStatusBanners(bot, ["u1"], NOW);

    expect(bot.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("skips a user with no banner yet — creation belongs to the tick", async () => {
    // The `statusMessageId: { not: null }` filter is what excludes them, so the
    // query simply returns nothing.
    mockPrisma.user.findMany.mockResolvedValue([]);
    const bot = api();

    await refreshStatusBanners(bot, ["u1"], NOW);

    expect(bot.editMessageText).not.toHaveBeenCalled();
    expect(mockPrisma.match.findMany).not.toHaveBeenCalled();
  });

  it("never throws when Telegram rejects the edit", async () => {
    mockPrisma.user.findMany.mockResolvedValue([participant()]);
    mockPrisma.match.findMany.mockResolvedValue([scheduledAt("Aroma Kava")]);
    const bot = api();
    bot.editMessageText.mockRejectedValue(
      telegramError(400, "Bad Request: message to edit not found"),
    );

    await expect(refreshStatusBanners(bot, ["u1"], NOW)).resolves.toBeUndefined();
    // Recovery is the tick's job: nothing is cached, so it retries.
    expect(statusBannerRenderCache.size).toBe(0);
  });

  it("never throws when the database is unavailable", async () => {
    mockPrisma.user.findMany.mockRejectedValue(new Error("db unavailable"));
    const bot = api();

    await expect(refreshStatusBanners(bot, ["u1"], NOW)).resolves.toBeUndefined();
    expect(bot.editMessageText).not.toHaveBeenCalled();
  });

  it("treats a lost race with the tick as done, not as a failure", async () => {
    mockPrisma.user.findMany.mockResolvedValue([participant()]);
    mockPrisma.match.findMany.mockResolvedValue([scheduledAt("Aroma Kava")]);
    const bot = api();
    bot.editMessageText.mockRejectedValue(
      telegramError(400, "Bad Request: message is not modified"),
    );

    await refreshStatusBanners(bot, ["u1"], NOW);

    expect(statusBannerRenderCache.size).toBe(1);
  });
});
