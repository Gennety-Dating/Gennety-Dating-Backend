import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./chat-events.js", () => ({
  recordChatEventForChat: vi.fn().mockResolvedValue(undefined),
  resolveChatTarget: vi.fn().mockResolvedValue({ userId: "u1", recordable: true }),
  forgetChatEventForMessage: vi.fn().mockResolvedValue(undefined),
}));

import {
  forgetChatEventForMessage,
  recordChatEventForChat,
  resolveChatTarget,
} from "./chat-events.js";
import {
  extractActions,
  matchIdFromActions,
  miniAppPageFromUrl,
  outboundRecorder,
  recordOutboundMessage,
  surfaceFromActions,
  withEphemeralSends,
} from "./outbound-recorder.js";

const record = recordChatEventForChat as ReturnType<typeof vi.fn>;
const forget = forgetChatEventForMessage as ReturnType<typeof vi.fn>;
const resolve = resolveChatTarget as ReturnType<typeof vi.fn>;

/** Minimal `prev` stand-in: succeeds and hands back one message. */
function okPrev(messageId = 11) {
  return vi.fn().mockResolvedValue({ ok: true, result: { message_id: messageId } });
}

/** Invoke the transformer the way grammY does. */
function call(method: string, payload: unknown, prev = okPrev()) {
  const transformer = outboundRecorder as unknown as (
    prev: unknown,
    method: string,
    payload: unknown,
  ) => Promise<unknown>;
  return { promise: transformer(prev, method, payload), prev };
}

/** Recording is fire-and-forget — let the microtask queue drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockResolvedValue({ userId: "u1", recordable: true });
});

describe("payload readers", () => {
  it("reads button labels, callback data and Mini App pages", () => {
    const actions = extractActions({
      inline_keyboard: [
        [{ text: "📍 Open in Maps", url: "https://maps" }],
        [
          { text: "📍 Change venue", web_app: { url: "https://app/venue-change.html?x=1" } },
          { text: "Share", callback_data: "datecard:share:abc" },
        ],
      ],
    });
    expect(actions).toEqual([
      { label: "📍 Open in Maps" },
      { label: "📍 Change venue", webApp: "venue-change" },
      { label: "Share", data: "datecard:share:abc" },
    ]);
  });

  it("reads a reply-keyboard panel too", () => {
    expect(extractActions({ keyboard: [[{ text: "🗂 My photos" }]] })).toEqual([
      { label: "🗂 My photos" },
    ]);
  });

  it("derives the surface from a callback prefix, then from the Mini App", () => {
    expect(surfaceFromActions([{ label: "x", data: "vchg:paydecline:1" }])).toBe(
      "venue_change",
    );
    expect(surfaceFromActions([{ label: "x", webApp: "ticket" }])).toBe("ticket");
    expect(surfaceFromActions([{ label: "x" }])).toBeNull();
  });

  it("pulls the match id out of callback data", () => {
    expect(
      matchIdFromActions([
        { label: "x", data: "match:accept:3fa85f64-5717-4562-b3fc-2c963f66afa6" },
      ]),
    ).toBe("3fa85f64-5717-4562-b3fc-2c963f66afa6");
  });

  it("names the Mini App page from its URL", () => {
    expect(miniAppPageFromUrl("https://app.example/index.html")).toBe("index");
    expect(miniAppPageFromUrl("not a url")).toBeNull();
  });
});

describe("outboundRecorder", () => {
  it("records a sent message with its buttons", async () => {
    const { promise } = call("sendMessage", {
      chat_id: 555,
      text: "You're keeping Aroma Kava, as originally planned.",
      reply_markup: { inline_keyboard: [[{ text: "📍 Change venue", callback_data: "vchg:o" }]] },
    });
    await promise;
    await flush();

    expect(record).toHaveBeenCalledTimes(1);
    const [chatId, event] = record.mock.calls[0]!;
    expect(chatId).toBe(555n);
    expect(event).toMatchObject({
      direction: "out",
      kind: "text",
      summary: "You're keeping Aroma Kava, as originally planned.",
      surface: "venue_change",
      telegramMessageId: 11,
    });
  });

  it("labels a photo card and falls back to a caption-less placeholder", async () => {
    await call("sendPhoto", { chat_id: 555, photo: "file" }).promise;
    await flush();
    expect(record.mock.calls[0]![1]).toMatchObject({
      kind: "photo",
      summary: "(photo card, no caption)",
    });
  });

  it("takes an album's caption from its first captioned item", async () => {
    await call("sendMediaGroup", {
      chat_id: 555,
      media: [{ caption: "" }, { caption: "Anna, 24" }],
    }).promise;
    await flush();
    expect(record.mock.calls[0]![1]).toMatchObject({ kind: "album", summary: "Anna, 24" });
  });

  it("ignores edits — the banner and countdown re-render every minute", async () => {
    await call("editMessageText", { chat_id: 555, message_id: 3, text: "Drop in 2d 6h" }).promise;
    await call("editMessageReplyMarkup", { chat_id: 555, message_id: 3 }).promise;
    await call("sendChatAction", { chat_id: 555, action: "typing" }).promise;
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  it("ignores ephemeral rich drafts", async () => {
    await call("sendRichMessageDraft", { chat_id: 555, draft_id: 1 }).promise;
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  it("ignores sends marked ephemeral by their caller", async () => {
    await withEphemeralSends(async () => {
      await call("sendMessage", { chat_id: 555, text: "analysing…" }).promise;
    });
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  it("still records normally once the ephemeral scope has exited", async () => {
    await withEphemeralSends(async () => {
      await call("sendMessage", { chat_id: 555, text: "analysing…" }).promise;
    });
    await call("sendMessage", { chat_id: 555, text: "done" }).promise;
    await flush();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![1]).toMatchObject({ summary: "done" });
  });

  it("drops the row for a message that gets deleted", async () => {
    await call("deleteMessage", { chat_id: 555, message_id: 42 }).promise;
    await flush();
    expect(forget).toHaveBeenCalledWith("u1", 42);
  });

  it("skips non-numeric chats (channel usernames)", async () => {
    await call("sendMessage", { chat_id: "@gennety", text: "hi" }).promise;
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  it("records nothing when the API call failed", async () => {
    const prev = vi.fn().mockResolvedValue({ ok: false, error_code: 403 });
    await call("sendMessage", { chat_id: 555, text: "hi" }, prev).promise;
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  it("passes the API result through untouched", async () => {
    const prev = okPrev(99);
    const result = await call("sendMessage", { chat_id: 555, text: "hi" }, prev).promise;
    expect(result).toEqual({ ok: true, result: { message_id: 99 } });
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it("lets a send error propagate rather than swallowing it", async () => {
    const prev = vi.fn().mockRejectedValue(new Error("blocked"));
    await expect(call("sendMessage", { chat_id: 555, text: "hi" }, prev).promise).rejects.toThrow(
      "blocked",
    );
  });
});

describe("recordOutboundMessage", () => {
  it("records an explicit final line with its keyboard", () => {
    recordOutboundMessage(555, "Got yours, waiting on your partner…", {
      replyMarkup: { inline_keyboard: [[{ text: "Open Calendar", callback_data: "sched:x" }]] },
      telegramMessageId: 7,
    });
    expect(record).toHaveBeenCalledWith(555, {
      direction: "out",
      kind: "text",
      summary: "Got yours, waiting on your partner…",
      surface: "calendar",
      actions: [{ label: "Open Calendar", data: "sched:x" }],
      telegramMessageId: 7,
      matchId: null,
    });
  });
});
