import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

import { streamDrafts, streamDraftsToChat } from "./ai-stream.js";

function createCtx(chatId: number = 42) {
  return {
    chat: { id: chatId },
    api: {
      raw: {
        sendMessageDraft: vi.fn().mockResolvedValue(undefined),
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function noopWait() {
  return async (_ms: number) => {};
}

describe("streamDrafts", () => {
  it("does nothing when chunks is empty", async () => {
    const ctx = createCtx();
    await streamDrafts(ctx, [], { wait: noopWait() });
    expect(ctx.api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("sends single chunk as final reply without drafts", async () => {
    const ctx = createCtx();
    await streamDrafts(ctx, ["Only message"], { wait: noopWait() });
    expect(ctx.api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("Only message");
  });

  it("streams drafts then sends final reply for multiple chunks", async () => {
    const ctx = createCtx();
    await streamDrafts(ctx, ["Draft 1", "Draft 2", "Final"], { wait: noopWait() });

    expect(ctx.api.raw.sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(ctx.api.raw.sendMessageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: 42, text: "Draft 1" }),
    );
    expect(ctx.api.raw.sendMessageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: 42, text: "Draft 2" }),
    );
    expect(ctx.reply).toHaveBeenCalledWith("Final");
  });

  it("uses a consistent non-zero draft_id across calls", async () => {
    const ctx = createCtx();
    await streamDrafts(ctx, ["A", "B", "C"], { wait: noopWait() });

    const ids = ctx.api.raw.sendMessageDraft.mock.calls.map(
      (c: any[]) => c[0].draft_id,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(0);
  });

  it("degrades gracefully when sendMessageDraft throws", async () => {
    const ctx = createCtx();
    ctx.api.raw.sendMessageDraft.mockRejectedValueOnce(new Error("not supported"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await streamDrafts(ctx, ["Draft", "Final"], { wait: noopWait() });

    // Draft fails, final reply still sent
    expect(ctx.reply).toHaveBeenCalledWith("Final");
    warnSpy.mockRestore();
  });

  it("does nothing when chat id is undefined", async () => {
    const ctx = { chat: undefined, api: { raw: { sendMessageDraft: vi.fn() } }, reply: vi.fn() } as any;
    await streamDrafts(ctx, ["A", "B"], { wait: noopWait() });
    expect(ctx.api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe("streamDraftsToChat", () => {
  it("streams drafts to a specific chat and sends final message", async () => {
    const api = {
      raw: { sendMessageDraft: vi.fn().mockResolvedValue(undefined) },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any;

    await streamDraftsToChat(api, 1001, ["D1", "D2", "Final"], { wait: noopWait() });

    expect(api.raw.sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenCalledWith(1001, "Final", {});
  });

  it("attaches replyMarkup and entities to the final message", async () => {
    const api = {
      raw: { sendMessageDraft: vi.fn().mockResolvedValue(undefined) },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const markup = { inline_keyboard: [[{ text: "X", callback_data: "x" }]] };
    const entities = [{ type: "bold" as const, offset: 0, length: 5 }];

    await streamDraftsToChat(api, 1001, ["Draft", "Final"], {
      wait: noopWait(),
      replyMarkup: markup,
      entities,
    });

    expect(api.sendMessage).toHaveBeenCalledWith(1001, "Final", {
      reply_markup: markup,
      entities,
    });
  });

  it("handles single chunk — no drafts, only final message", async () => {
    const api = {
      raw: { sendMessageDraft: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any;

    await streamDraftsToChat(api, 1001, ["Only"], { wait: noopWait() });

    expect(api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(1001, "Only", {});
  });

  it("degrades gracefully when sendMessageDraft throws", async () => {
    const api = {
      raw: { sendMessageDraft: vi.fn().mockRejectedValue(new Error("boom")) },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await streamDraftsToChat(api, 1001, ["D1", "Final"], { wait: noopWait() });

    expect(api.sendMessage).toHaveBeenCalledWith(1001, "Final", {});
    warnSpy.mockRestore();
  });
});
