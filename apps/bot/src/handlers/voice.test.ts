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

/**
 * A recording used as an ANSWER is never narrated — on any step, onboarding
 * included (founder decision, PRODUCT_SPEC §1.3). The `<tg-thinking>` shimmer
 * belongs to the §1.3b voice PROMPT step, where the recording is the
 * deliverable rather than a way of typing, and `voiceCheckSteps` covers a real
 * validation pipeline there.
 *
 * These are regression guards rather than descriptions: a two-beat status over
 * every spoken onboarding answer shipped once and had to be taken back out.
 */
describe("voiceHandler — a spoken answer is never narrated", () => {
  for (const step of ["consent", "language", "conversational", "completed"] as const) {
    it(`keeps the plain chat-action path on '${step}'`, async () => {
      const h = harness(step);

      expect(await h.run()).toBe(true);
      expect(status).not.toHaveBeenCalled();
      expect(
        h.calls.filter((c) => c.method === "sendChatAction").map((c) => c.payload.action),
      ).toEqual(["record_voice", "typing"]);
      expect(h.ctx.message?.text).toBe("мне нравится бегать по утрам");
    });
  }

  it("still answers a failed transcription with the localized refusal", async () => {
    whisper.mockResolvedValue(null);
    const h = harness("conversational");

    expect(await h.run()).toBe(false);
    expect(status).not.toHaveBeenCalled();
    expect(h.calls.at(-1)?.payload.text).toBe(t("ru", "voiceTranscriptionFailed"));
  });
});
