import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/chat-events.js", () => ({
  recordChatEventForChat: vi.fn().mockResolvedValue(undefined),
}));

import { recordChatEventForChat } from "../services/chat-events.js";
import type { BotContext } from "../session.js";
import { interactionRecorder, labelForCallbackData } from "./interaction-recorder.js";

const record = recordChatEventForChat as ReturnType<typeof vi.fn>;

/** Drive the middleware exactly as grammY would. */
async function run(ctx: Partial<BotContext>): Promise<boolean> {
  let continued = false;
  await interactionRecorder.middleware()(ctx as BotContext, async () => {
    continued = true;
  });
  return continued;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("labelForCallbackData", () => {
  it("finds the tapped button's own label", () => {
    const markup = {
      inline_keyboard: [
        [{ text: "📍 Open in Maps", callback_data: "noop" }],
        [{ text: "📍 Change venue", callback_data: "vchg:open:1" }],
      ],
    };
    expect(labelForCallbackData(markup, "vchg:open:1")).toBe("📍 Change venue");
    expect(labelForCallbackData(markup, "missing")).toBeNull();
    expect(labelForCallbackData(undefined, "vchg:open:1")).toBeNull();
  });
});

describe("interactionRecorder", () => {
  it("records a tap by the label the user actually saw", async () => {
    await run({
      chat: { id: 555 } as BotContext["chat"],
      callbackQuery: {
        data: "vchg:open:3fa85f64-5717-4562-b3fc-2c963f66afa6",
        message: {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📍 Change venue",
                  callback_data: "vchg:open:3fa85f64-5717-4562-b3fc-2c963f66afa6",
                },
              ],
            ],
          },
        },
      } as unknown as BotContext["callbackQuery"],
    });

    expect(record).toHaveBeenCalledTimes(1);
    const [chatId, event] = record.mock.calls[0]!;
    expect(chatId).toBe(555);
    expect(event).toMatchObject({
      direction: "in",
      kind: "callback_tap",
      summary: 'tapped "📍 Change venue"',
      surface: "venue_change",
      matchId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
  });

  it("falls back to the raw data when the keyboard is gone", async () => {
    await run({
      chat: { id: 555 } as BotContext["chat"],
      callbackQuery: { data: "menu:open" } as unknown as BotContext["callbackQuery"],
    });
    expect(record.mock.calls[0]![1]).toMatchObject({
      summary: "tapped a button (menu:open)",
      surface: "menu",
    });
  });

  it("records typed text", async () => {
    await run({
      chat: { id: 555 } as BotContext["chat"],
      message: { text: "Почему?" } as BotContext["message"],
    });
    expect(record.mock.calls[0]![1]).toMatchObject({
      direction: "in",
      kind: "user_text",
      summary: "Почему?",
    });
  });

  it("leaves voice notes to the transcribing handler", async () => {
    await run({
      chat: { id: 555 } as BotContext["chat"],
      message: { voice: { file_id: "v" } } as unknown as BotContext["message"],
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("ignores Telegram's own pinned-message service update", async () => {
    await run({
      chat: { id: 555 } as BotContext["chat"],
      message: { pinned_message: {} } as unknown as BotContext["message"],
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("records sent media generically", async () => {
    await run({
      chat: { id: 555 } as BotContext["chat"],
      message: { photo: [{ file_id: "p" }] } as unknown as BotContext["message"],
    });
    expect(record.mock.calls[0]![1]).toMatchObject({
      kind: "user_media",
      summary: "sent a photo",
    });
  });

  it("always continues the middleware chain, even when recording throws", async () => {
    record.mockImplementation(() => {
      throw new Error("db down");
    });
    const continued = await run({
      chat: { id: 555 } as BotContext["chat"],
      message: { text: "hi" } as BotContext["message"],
    });
    expect(continued).toBe(true);
  });
});
