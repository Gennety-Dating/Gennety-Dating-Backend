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
    CUSTOM_EMOJI_THINKING_ID: "",
  },
}));

import {
  streamDrafts,
  streamDraftsToChat,
  runStatusSequence,
  runThinkingStatusSequence,
} from "./ai-stream.js";
import { thinkingHtml } from "./telegram-rich.js";

function createCtx(chatId: number = 42) {
  return {
    chat: { id: chatId },
    api: {
      editMessageText: vi.fn().mockResolvedValue({ message_id: 7, chat: { id: chatId } }),
      raw: {
        sendMessageDraft: vi.fn().mockResolvedValue(undefined),
      },
    },
    reply: vi.fn().mockResolvedValue({ message_id: 7, chat: { id: chatId } }),
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

  it("sends single chunk as a final reply without drafts", async () => {
    const ctx = createCtx();
    await streamDrafts(ctx, ["Only message"], { wait: noopWait() });
    expect(ctx.api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("Only message");
  });

  it("streams multiple chunks by editing one bottom message", async () => {
    const ctx = createCtx();
    await streamDrafts(ctx, ["Draft 1", "Draft 2", "Final"], { wait: noopWait() });

    expect(ctx.api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith("Draft 1");
    expect(ctx.api.editMessageText).toHaveBeenNthCalledWith(1, 42, 7, "Draft 2");
    expect(ctx.api.editMessageText).toHaveBeenNthCalledWith(2, 42, 7, "Final");
  });

  it("keeps one message id across all stream edits", async () => {
    const ctx = createCtx();
    await streamDrafts(ctx, ["A", "B", "C"], { wait: noopWait() });

    expect(ctx.api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(ctx.api.editMessageText).toHaveBeenNthCalledWith(1, 42, 7, "B");
    expect(ctx.api.editMessageText).toHaveBeenNthCalledWith(2, 42, 7, "C");
  });

  it("falls back to a fresh final reply when the final edit throws", async () => {
    const ctx = createCtx();
    ctx.api.editMessageText.mockRejectedValueOnce(new Error("edit failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await streamDrafts(ctx, ["Draft", "Final"], { wait: noopWait() });

    expect(ctx.api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenNthCalledWith(1, "Draft");
    expect(ctx.reply).toHaveBeenNthCalledWith(2, "Final");
    warnSpy.mockRestore();
  });

  it("does nothing when chat id is undefined", async () => {
    const ctx = {
      chat: undefined,
      api: { editMessageText: vi.fn(), raw: { sendMessageDraft: vi.fn() } },
      reply: vi.fn(),
    } as any;
    await streamDrafts(ctx, ["A", "B"], { wait: noopWait() });
    expect(ctx.api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe("streamDraftsToChat", () => {
  it("streams chunks to a specific chat by editing one message", async () => {
    const api = {
      raw: { sendMessageDraft: vi.fn().mockResolvedValue(undefined) },
      sendMessage: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: 1001 } }),
      editMessageText: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: 1001 } }),
    } as any;

    await streamDraftsToChat(api, 1001, ["D1", "D2", "Final"], { wait: noopWait() });

    expect(api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(1001, "D1");
    expect(api.editMessageText).toHaveBeenNthCalledWith(1, 1001, 100, "D2", {});
    expect(api.editMessageText).toHaveBeenNthCalledWith(2, 1001, 100, "Final", {});
  });

  it("attaches replyMarkup and entities to the final edit", async () => {
    const api = {
      raw: { sendMessageDraft: vi.fn().mockResolvedValue(undefined) },
      sendMessage: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: 1001 } }),
      editMessageText: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: 1001 } }),
    } as any;
    const markup = { inline_keyboard: [[{ text: "X", callback_data: "x" }]] };
    const entities = [{ type: "bold" as const, offset: 0, length: 5 }];

    await streamDraftsToChat(api, 1001, ["Draft", "Final"], {
      wait: noopWait(),
      replyMarkup: markup,
      entities,
    });

    expect(api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.editMessageText).toHaveBeenCalledWith(1001, 100, "Final", {
      reply_markup: markup,
      entities,
    });
  });

  it("handles single chunk with one final message", async () => {
    const api = {
      raw: { sendMessageDraft: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: 1001 } }),
      editMessageText: vi.fn(),
    } as any;

    await streamDraftsToChat(api, 1001, ["Only"], { wait: noopWait() });

    expect(api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(1001, "Only", {});
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("falls back to a fresh final message when the final edit throws", async () => {
    const api = {
      raw: { sendMessageDraft: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: 1001 } }),
      editMessageText: vi.fn().mockRejectedValue(new Error("boom")),
    } as any;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await streamDraftsToChat(api, 1001, ["D1", "Final"], { wait: noopWait() });

    expect(api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 1001, "D1");
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

describe("runStatusSequence (rich thinking path)", () => {
  function createRichApi(opts: { firstDraftFails?: boolean } = {}) {
    return {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7 }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      raw: {
        sendRichMessageDraft: opts.firstDraftFails
          ? vi.fn().mockRejectedValue(new Error("rich unsupported"))
          : vi.fn().mockResolvedValue(true),
        sendRichMessage: vi.fn().mockResolvedValue({ message_id: 9 }),
      },
    } as any;
  }

  const steps = [
    { text: "S1", holdMs: 10 },
    { text: "S2", holdMs: 20 },
    { text: "S3", holdMs: 30 },
  ];

  it("streams <tg-thinking> drafts and touches no classic primitive (deleteAtEnd default)", async () => {
    const api = createRichApi();
    await runStatusSequence(api, 5, steps, { wait: noopWait(), rich: true });

    expect(api.raw.sendRichMessageDraft).toHaveBeenCalledTimes(3);
    expect(api.raw.sendRichMessageDraft).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat_id: 5,
        rich_message: { html: "<tg-thinking>S1</tg-thinking>" },
      }),
    );
    // No real message is sent — the ephemeral draft self-expires.
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
  });

  it("shares one non-zero draft_id across all steps", async () => {
    const api = createRichApi();
    await runStatusSequence(api, 5, steps, { wait: noopWait(), rich: true });
    const ids = api.raw.sendRichMessageDraft.mock.calls.map((c: any[]) => c[0].draft_id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[0]).not.toBe(0);
  });

  it("persists the final line via sendRichMessage when deleteAtEnd is false", async () => {
    const api = createRichApi();
    await runStatusSequence(api, 5, steps, {
      wait: noopWait(),
      rich: true,
      deleteAtEnd: false,
    });

    // Last step is finalised as a real message, not an ephemeral draft.
    expect(api.raw.sendRichMessageDraft).toHaveBeenCalledTimes(2);
    expect(api.raw.sendRichMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: 5, rich_message: { markdown: "S3" } }),
    );
  });

  it("holds each step for its own duration on the rich path", async () => {
    const api = createRichApi();
    const waited: number[] = [];
    await runStatusSequence(api, 5, steps, {
      wait: async (ms: number) => {
        waited.push(ms);
      },
      rich: true,
    });
    expect(waited).toEqual([10, 20, 30]);
  });

  it("falls back to the classic sequence when the first rich draft fails", async () => {
    const api = createRichApi({ firstDraftFails: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runStatusSequence(api, 5, steps, { wait: noopWait(), rich: true });

    // Classic path took over: send first, edit through the rest, delete.
    expect(api.sendMessage).toHaveBeenCalledWith(5, "S1");
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.deleteMessage).toHaveBeenCalledWith(5, 7);
    warnSpy.mockRestore();
  });

  it("runThinkingStatusSequence returns false when nothing was shown", async () => {
    const api = createRichApi({ firstDraftFails: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handled = await runThinkingStatusSequence(api, 5, steps, { wait: noopWait() });
    expect(handled).toBe(false);
    warnSpy.mockRestore();
  });

  it("upgrades the leading glyph to the animated AI emoji when thinkingEmojiId is set", async () => {
    const api = createRichApi();
    const emojiSteps = [{ text: "🧠 Reading your context…", holdMs: 5 }];
    await runStatusSequence(api, 5, emojiSteps, {
      wait: noopWait(),
      rich: true,
      thinkingEmojiId: "555",
    });
    expect(api.raw.sendRichMessageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        rich_message: {
          html: '<tg-thinking><tg-emoji emoji-id="555">🧠</tg-emoji> Reading your context…</tg-thinking>',
        },
      }),
    );
  });
});

describe("runStatusSequence (until: tracked work)", () => {
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

  it("holds the status until the tracked work resolves, then deletes (classic)", async () => {
    const api = createApi();
    let resolveWork!: () => void;
    const work = new Promise<void>((r) => {
      resolveWork = r;
    });

    const p = runStatusSequence(api, 5, steps, { wait: noopWait(), until: work });
    // Scripted steps play out immediately (noop wait), then the sequence holds.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.deleteMessage).not.toHaveBeenCalled(); // still holding the last line

    resolveWork();
    await p;
    expect(api.deleteMessage).toHaveBeenCalledWith(5, 7);
  });

  it("cuts narration short when the work settles during a step (classic)", async () => {
    const api = createApi();
    const work = Promise.resolve(); // already done before the first hold
    const realWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    await runStatusSequence(api, 5, steps, { wait: realWait, until: work });

    // Only the first frame is shown; the settled work skips the remaining edits.
    expect(api.sendMessage).toHaveBeenCalledWith(5, "Step 1");
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).toHaveBeenCalledWith(5, 7);
  });

  it("can defer tracked-work cut-short behavior until a later step", async () => {
    const api = createApi();
    const deferredSteps = [
      { text: "Step 1", holdMs: 100 },
      { text: "Step 2", holdMs: 200 },
      { text: "Step 3", holdMs: 300 },
      { text: "Ready when work is", holdMs: 0 },
    ];
    const waited: number[] = [];
    const wait = async (ms: number) => {
      waited.push(ms);
    };

    await runStatusSequence(api, 5, deferredSteps, {
      wait,
      until: Promise.resolve(),
      untilFromStepIndex: 3,
    });

    expect(waited).toEqual([100, 200, 300, 0]);
    expect(api.editMessageText).toHaveBeenCalledTimes(3);
    expect(api.editMessageText).toHaveBeenNthCalledWith(3, 5, 7, "Ready when work is");
    expect(api.deleteMessage).toHaveBeenCalledWith(5, 7);
  });

  it("still tears down the status when the tracked work rejects", async () => {
    const api = createApi();
    let rejectWork!: (e: unknown) => void;
    const work = new Promise<void>((_, rej) => {
      rejectWork = rej;
    });

    const p = runStatusSequence(api, 5, steps, { wait: noopWait(), until: work });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.deleteMessage).not.toHaveBeenCalled();

    rejectWork(new Error("render failed"));
    await p; // makeSettle catches the rejection; the status still tears down
    expect(api.deleteMessage).toHaveBeenCalledWith(5, 7);
  });

  it("holds the last <tg-thinking> draft until the work resolves (rich)", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7 }),
      raw: {
        sendRichMessageDraft: vi.fn().mockResolvedValue(true),
        sendRichMessage: vi.fn().mockResolvedValue({ message_id: 9 }),
      },
    } as any;
    let resolveWork!: () => void;
    const work = new Promise<void>((r) => {
      resolveWork = r;
    });

    const p = runStatusSequence(api, 5, steps, {
      wait: noopWait(),
      rich: true,
      until: work,
    });
    await new Promise((r) => setTimeout(r, 0));
    // All beats issued; the sequence is now holding on the work promise.
    expect(api.raw.sendRichMessageDraft).toHaveBeenCalledTimes(3);
    expect(api.sendMessage).not.toHaveBeenCalled();

    resolveWork();
    await p; // resolves cleanly once the work settles (no real message sent)
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("runStatusSequence (per-step emoji)", () => {
  function createRichApi() {
    return {
      raw: { sendRichMessageDraft: vi.fn().mockResolvedValue(true) },
    } as any;
  }

  it("uses the per-step emojiId on the rich path", async () => {
    const api = createRichApi();
    await runStatusSequence(api, 5, [{ text: "🎨 Building…", holdMs: 5, emojiId: "777" }], {
      wait: noopWait(),
      rich: true,
    });
    expect(api.raw.sendRichMessageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        rich_message: {
          html: '<tg-thinking><tg-emoji emoji-id="777">🎨</tg-emoji> Building…</tg-thinking>',
        },
      }),
    );
  });

  it("per-step emojiId overrides the sequence-level thinkingEmojiId", async () => {
    const api = createRichApi();
    const stepsX = [
      { text: "🔍 A…", holdMs: 1, emojiId: "111" },
      { text: "📍 B…", holdMs: 1 },
    ];
    await runStatusSequence(api, 5, stepsX, {
      wait: noopWait(),
      rich: true,
      thinkingEmojiId: "999",
    });
    expect(api.raw.sendRichMessageDraft).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        rich_message: {
          html: '<tg-thinking><tg-emoji emoji-id="111">🔍</tg-emoji> A…</tg-thinking>',
        },
      }),
    );
    expect(api.raw.sendRichMessageDraft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        rich_message: {
          html: '<tg-thinking><tg-emoji emoji-id="999">📍</tg-emoji> B…</tg-thinking>',
        },
      }),
    );
  });
});

describe("thinkingHtml", () => {
  it("wraps a bare label with no emoji id", () => {
    expect(thinkingHtml("Analysing")).toBe("<tg-thinking>Analysing</tg-thinking>");
  });

  it("upgrades the leading emoji to <tg-emoji> when an id is given", () => {
    expect(thinkingHtml("🔍 Matching your selfie…", "999")).toBe(
      '<tg-thinking><tg-emoji emoji-id="999">🔍</tg-emoji> Matching your selfie…</tg-thinking>',
    );
  });

  it("leaves the label verbatim when an id is given but there is no leading emoji", () => {
    expect(thinkingHtml("Why you click…", "999")).toBe(
      "<tg-thinking>Why you click…</tg-thinking>",
    );
  });

  it("keeps the plain glyph (no <tg-emoji>) when no id is given", () => {
    expect(thinkingHtml("🧠 Reading your context…")).toBe(
      "<tg-thinking>🧠 Reading your context…</tg-thinking>",
    );
  });

  it("HTML-escapes the body", () => {
    expect(thinkingHtml("Comparing <a> & <b>")).toBe(
      "<tg-thinking>Comparing &lt;a&gt; &amp; &lt;b&gt;</tg-thinking>",
    );
  });
});

describe("streamDraftsToChat (rich pitch path)", () => {
  it("streams rich drafts with a <tg-thinking> beat, finalises via plain sendMessage + keyboard", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
      raw: { sendRichMessageDraft: vi.fn().mockResolvedValue(true) },
    } as any;
    const markup = { inline_keyboard: [[{ text: "Accept", callback_data: "a" }]] };
    const chunks = ["Headline", "Deadline", "Analysing", "Pitch text", "FINAL"];

    const res = await streamDraftsToChat(api, 1001, chunks, {
      wait: noopWait(),
      rich: true,
      thinkingIndex: 2,
      replyMarkup: markup,
    });

    // 4 drafts (every chunk except the final), order preserved.
    expect(api.raw.sendRichMessageDraft).toHaveBeenCalledTimes(4);
    // Non-thinking chunks render as growing markdown.
    expect(api.raw.sendRichMessageDraft).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ chat_id: 1001, rich_message: { markdown: "Headline" } }),
    );
    // The thinkingIndex chunk renders as a <tg-thinking> shimmer.
    expect(api.raw.sendRichMessageDraft).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        rich_message: { html: "<tg-thinking>Analysing</tg-thinking>" },
      }),
    );
    // Final stays a plain text message (so the countdown worker can edit it).
    expect(api.sendMessage).toHaveBeenCalledWith(1001, "FINAL", { reply_markup: markup });
    expect(res?.message_id).toBe(100);
  });

  it("falls back to the bottom edit stream when the first rich draft fails", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: 1001 } }),
      editMessageText: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: 1001 } }),
      raw: {
        sendRichMessageDraft: vi.fn().mockRejectedValue(new Error("rich unsupported")),
        sendMessageDraft: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await streamDraftsToChat(api, 1001, ["D1", "D2", "FINAL"], { wait: noopWait(), rich: true });

    expect(api.raw.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(1001, "D1");
    expect(api.editMessageText).toHaveBeenNthCalledWith(1, 1001, 100, "D2", {});
    expect(api.editMessageText).toHaveBeenNthCalledWith(2, 1001, 100, "FINAL", {});
    warnSpy.mockRestore();
  });
});
