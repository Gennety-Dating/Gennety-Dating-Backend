import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    OPENAI_API_KEY: "",
    WEBAPP_URL: "https://test.invalid/calendar",
    CUSTOM_EMOJI_THINKING_ID: "",
  },
}));

vi.mock("./telegram-rich.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-rich.js")>();
  return {
    ...actual,
    sendRichMessageDraft: vi.fn().mockResolvedValue(undefined),
    sendRichMessage: vi.fn().mockResolvedValue({ message_id: 77, text: "final" }),
  };
});

vi.mock("./outbound-recorder.js", () => ({
  recordOutboundMessage: vi.fn(),
  withEphemeralSends: <T>(fn: () => Promise<T>) => fn(),
}));

import type { Api, RawApi } from "grammy";
import { sendRichMessage } from "./telegram-rich.js";
import { recordOutboundMessage } from "./outbound-recorder.js";
import { streamComposedRich } from "./ai-stream.js";

const record = recordOutboundMessage as ReturnType<typeof vi.fn>;
const richFinal = sendRichMessage as ReturnType<typeof vi.fn>;

function fakeApi(): Api<RawApi> {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 88, text: "final" }),
  } as unknown as Api<RawApi>;
}

const noWait = async () => {};

beforeEach(() => {
  vi.clearAllMocks();
  richFinal.mockResolvedValue({ message_id: 77, text: "final" });
});

describe("streamComposedRich", () => {
  it("records the rich final message on the chat timeline", async () => {
    // `sendRichMessage` is a raw Bot API call, so the outbound transformer
    // never sees it. Without this the Profiler's entire question stream was
    // absent from the transcript — a user's answers with nothing above them.
    const api = fakeApi();
    await streamComposedRich(
      api,
      555,
      [{ text: "thinking", holdMs: 0 }],
      ["What are you watching right now?"],
      { wait: noWait },
    );

    expect(record).toHaveBeenCalledWith(
      555,
      "What are you watching right now?",
      expect.objectContaining({ telegramMessageId: 77 }),
    );
  });

  it("carries the keyboard so the Skip button shows in the transcript", async () => {
    const api = fakeApi();
    const replyMarkup = {
      inline_keyboard: [[{ text: "Skip", callback_data: "profiler:skip:q1" }]],
    };
    await streamComposedRich(api, 555, [{ text: "…", holdMs: 0 }], ["Question?"], {
      wait: noWait,
      replyMarkup,
    });

    expect(record).toHaveBeenCalledWith(
      555,
      "Question?",
      expect.objectContaining({ replyMarkup }),
    );
  });

  it("does not double-record when the rich final falls back to a plain send", async () => {
    // The plain `sendMessage` fallback goes through the API transformer, which
    // records it already.
    richFinal.mockRejectedValue(new Error("rich unavailable"));
    const api = fakeApi();

    await streamComposedRich(api, 555, [{ text: "…", holdMs: 0 }], ["Question?"], {
      wait: noWait,
    });

    expect(api.sendMessage).toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("sends nothing at all for an empty stream", async () => {
    const api = fakeApi();
    expect(await streamComposedRich(api, 555, [], [], { wait: noWait })).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });
});
