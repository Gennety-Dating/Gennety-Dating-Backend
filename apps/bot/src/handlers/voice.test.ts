import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/whisper.js", () => ({
  transcribeVoice: vi.fn().mockResolvedValue("мне нравится бегать по утрам"),
}));
vi.mock("../services/chat-events.js", () => ({
  recordChatEventForChat: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/voice-prompt-pending.js", () => ({
  shouldClaimVoiceFromCollector: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/ai-stream.js", () => ({
  NEVER_CUT_SHORT: Number.POSITIVE_INFINITY,
  runStatusSequence: vi.fn().mockResolvedValue(undefined),
}));

import { Api, Context } from "grammy";
import { DEFAULT_SESSION, t, type OnboardingStep } from "@gennety/shared";
import type { BotContext } from "../session.js";
import { runStatusSequence } from "../services/ai-stream.js";
import { transcribeVoice } from "../services/whisper.js";
import { voiceHandler } from "./voice.js";

const status = runStatusSequence as ReturnType<typeof vi.fn>;
const whisper = transcribeVoice as ReturnType<typeof vi.fn>;

interface Harness {
  ctx: BotContext;
  calls: { method: string; payload: Record<string, unknown> }[];
  /** Every api call and every status run, in the order they actually happened. */
  order: string[];
  run: () => Promise<boolean>;
}

function harness(onboardingStep: OnboardingStep, order: string[] = []): Harness {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = new Api("123:test");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    order.push(method);
    const result =
      method === "getFile"
        ? { file_id: "f1", file_unique_id: "u1", file_path: "voice/file_0.oga" }
        : method === "sendMessage"
          ? { message_id: 99 }
          : true;
    return { ok: true, result } as never;
  });

  const ctx = new Context(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 555, type: "private" },
        from: { id: 777, is_bot: false, first_name: "T" },
        voice: {
          file_id: "f1",
          file_unique_id: "u1",
          duration: 6,
          mime_type: "audio/ogg",
        },
      },
    } as never,
    api,
    { id: 1, is_bot: true, first_name: "bot", username: "bot" } as never,
  ) as BotContext;
  (ctx as { session: BotContext["session"] }).session = {
    ...DEFAULT_SESSION,
    language: "ru",
    onboardingStep,
  };

  return {
    ctx,
    calls,
    order,
    run: async () => {
      let continued = false;
      await voiceHandler.middleware()(ctx, async () => {
        continued = true;
      });
      return continued;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  whisper.mockResolvedValue("мне нравится бегать по утрам");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-length": "3" },
      }),
    ),
  );
});

describe("voiceHandler — onboarding narration", () => {
  it("holds a two-beat status over the transcription and hands the text on", async () => {
    const h = harness("conversational");

    expect(await h.run()).toBe(true);

    expect(status).toHaveBeenCalledTimes(1);
    const [, chatId, steps, options] = status.mock.calls[0]!;
    expect(chatId).toBe(555);
    expect(steps.map((s: { text: string }) => s.text)).toEqual([
      t("ru", "voiceAnswerStep1"),
      t("ru", "voiceAnswerStep2"),
    ]);
    // The script is a script, not a progress bar: a fast Whisper call may not
    // collapse it, and the tracked work may only ever hold the LAST beat longer.
    expect(options.untilFromStepIndex).toBe(Number.POSITIVE_INFINITY);
    expect(options.until).toBeInstanceOf(Promise);
    expect(options.rich).toBe(true);

    expect(h.ctx.message?.text).toBe("мне нравится бегать по утрам");
  });

  it("sends no chat action while the status is on screen", async () => {
    const h = harness("conversational");
    await h.run();

    expect(h.calls.map((c) => c.method)).not.toContain("sendChatAction");
  });

  it("tears the status down before telling the user it failed", async () => {
    whisper.mockResolvedValue(null);
    const order: string[] = [];
    status.mockImplementation(async () => {
      order.push("status");
    });

    const h = harness("conversational", order);
    expect(await h.run()).toBe(false);

    // The status must have finished before the refusal is sent — a verdict
    // landing under a shimmer still claiming to be listening is the bot
    // contradicting itself, which §1.4 already had to fix once.
    expect(order.filter((entry) => entry === "status" || entry === "sendMessage")).toEqual([
      "status",
      "sendMessage",
    ]);
    expect(h.calls.at(-1)?.payload.text).toBe(t("ru", "voiceTranscriptionFailed"));
  });
});

describe("voiceHandler — post-onboarding is unchanged", () => {
  it("keeps the silent chat-action path for a completed user", async () => {
    const h = harness("completed");

    expect(await h.run()).toBe(true);
    expect(status).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.method === "sendChatAction").map((c) => c.payload.action)).toEqual([
      "record_voice",
      "typing",
    ]);
    expect(h.ctx.message?.text).toBe("мне нравится бегать по утрам");
  });
});
