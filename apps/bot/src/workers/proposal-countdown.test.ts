import { describe, it, expect, vi, beforeEach } from "vitest";
import { GrammyError } from "grammy";

// Mocks — prisma + config (pitch.js/buildMatchKeyboard is imported through the
// worker and pulls in config at module load).
vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_VERIFIED_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

import { prisma } from "@gennety/db";
import { proposalCountdownTick } from "./proposal-countdown.js";
import { PROPOSAL_TTL_MS } from "../utils/countdown-plate.js";

const NOW = new Date("2024-06-15T12:00:00Z");

function createApi() {
  return {
    editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
    editMessageText: vi.fn().mockResolvedValue({}),
  } as any;
}

// Dispatched 2h ago → ~22h left, well inside the live window.
function makeMatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "match-1",
    dispatchedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    pitchMessageIdA: 100,
    pitchMessageIdB: 200,
    acceptedByA: null,
    acceptedByB: null,
    userA: { telegramId: BigInt(1), language: "en" },
    userB: { telegramId: BigInt(2), language: "en" },
    ...overrides,
  };
}

describe("proposalCountdownTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.match.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("edits ONLY the reply markup (never the message body) with a countdown button", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeMatch()]);
    const api = createApi();
    const cache = new Map<string, string>();

    const result = await proposalCountdownTick(api, { now: NOW, renderCache: cache });

    expect(result.edited).toBe(2); // both sides
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.editMessageReplyMarkup).toHaveBeenCalledTimes(2);

    const [chatId, messageId, extra] = api.editMessageReplyMarkup.mock.calls[0];
    expect(chatId).toBe(1);
    expect(messageId).toBe(100);
    const buttons = extra.reply_markup.inline_keyboard.flat();
    // A live countdown button (match:countdown:) sits above Report.
    const countdownBtn = buttons.find((b: any) =>
      String(b.callback_data).startsWith("match:countdown:"),
    );
    expect(countdownBtn).toBeDefined();
    expect(countdownBtn.text).toMatch(/⏳/);
    expect(
      buttons.some((b: any) => b.callback_data === "report:open:match-1"),
    ).toBe(true);
  });

  it("skips a side that already accepted", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMatch({ acceptedByA: true }),
    ]);
    const api = createApi();

    const result = await proposalCountdownTick(api, { now: NOW, renderCache: new Map() });

    expect(result.edited).toBe(1); // only side B
    expect(api.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
    expect(api.editMessageReplyMarkup.mock.calls[0][0]).toBe(2);
  });

  it("caches the rendered label and skips a no-op re-render on the next tick", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeMatch()]);
    const api = createApi();
    const cache = new Map<string, string>();

    await proposalCountdownTick(api, { now: NOW, renderCache: cache });
    api.editMessageReplyMarkup.mockClear();

    // Same minute → identical label → no edits issued.
    const second = await proposalCountdownTick(api, { now: NOW, renderCache: cache });
    expect(second.edited).toBe(0);
    expect(second.skippedSameText).toBe(2);
    expect(api.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it("nulls out the per-side pitch message id when the message is gone", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeMatch()]);
    const api = createApi();
    api.editMessageReplyMarkup.mockRejectedValue(
      new GrammyError(
        "Bad Request: message to edit not found",
        { ok: false, error_code: 400, description: "Bad Request: message to edit not found" } as any,
        "editMessageReplyMarkup",
        {} as any,
      ),
    );

    const result = await proposalCountdownTick(api, { now: NOW, renderCache: new Map() });

    expect(result.cleared).toBe(2);
    expect(prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { pitchMessageIdA: null } }),
    );
    expect(prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { pitchMessageIdB: null } }),
    );
  });

  it("leaves an expired proposal to the expiry job (no edits past TTL)", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMatch({ dispatchedAt: new Date(NOW.getTime() - PROPOSAL_TTL_MS - 60_000) }),
    ]);
    const api = createApi();

    const result = await proposalCountdownTick(api, { now: NOW, renderCache: new Map() });

    expect(result.edited).toBe(0);
    expect(api.editMessageReplyMarkup).not.toHaveBeenCalled();
  });
});
