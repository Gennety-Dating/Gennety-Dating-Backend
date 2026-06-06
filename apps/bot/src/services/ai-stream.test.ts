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

import { streamDrafts, streamDraftsToChat, runStatusSequence } from "./ai-stream.js";

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

describe("runStatusSequence", () => {
  function createApi() {
    return {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7 }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  const steps = [
    { text: "Step 1", holdMs: 100 },
    { text: "Step 2", holdMs: 200 },
    { text: "Step 3", holdMs: 300 },
  ];

  it("does nothing when steps is empty", async () => {
    const api = createApi();
    await runStatusSequence(api, 5, [], { wait: noopWait() });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("sends first step, edits through the rest, then deletes by default", async () => {
    const api = createApi();
    await runStatusSequence(api, 5, steps, { wait: noopWait() });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(5, "Step 1");
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.editMessageText).toHaveBeenNthCalledWith(1, 5, 7, "Step 2");
    expect(api.editMessageText).toHaveBeenNthCalledWith(2, 5, 7, "Step 3");
    expect(api.deleteMessage).toHaveBeenCalledWith(5, 7);
  });

  it("leaves the final line in place when deleteAtEnd is false", async () => {
    const api = createApi();
    await runStatusSequence(api, 5, steps, { wait: noopWait(), deleteAtEnd: false });

    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("aborts cleanly when the initial send fails", async () => {
    const api = createApi();
    api.sendMessage.mockRejectedValueOnce(new Error("blocked"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runStatusSequence(api, 5, steps, { wait: noopWait() });

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("keeps morphing when an intermediate edit throws", async () => {
    const api = createApi();
    api.editMessageText.mockRejectedValueOnce(new Error("message not modified"));

    await runStatusSequence(api, 5, steps, { wait: noopWait() });

    // Both edits attempted despite the first throwing; final delete still runs.
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.deleteMessage).toHaveBeenCalledWith(5, 7);
  });

  it("holds each step for its own duration", async () => {
    const api = createApi();
    const waited: number[] = [];
    const wait = async (ms: number) => {
      waited.push(ms);
    };
    await runStatusSequence(api, 5, steps, { wait });
    expect(waited).toEqual([100, 200, 300]);
  });
});
